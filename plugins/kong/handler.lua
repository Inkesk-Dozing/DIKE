-- Kong Gateway Native Plugin: DIKE (Distributed Idempotency Key Engine)
-- Intercepts idempotent requests in access phase, replays cached responses on HIT,
-- and buffers/commits completed mutations during body_filter and log phases.

local http = require("resty.http")
local cjson = require("cjson.safe")
local ngx = ngx
local kong = kong

local DikeHandler = {
  PRIORITY = 900, -- Runs early in access phase before proxying upstream
  VERSION = "0.1.0",
}

local function is_method_enforced(method, enforce_methods)
  if not enforce_methods then
    return true
  end
  for _, m in ipairs(enforce_methods) do
    if m == method then
      return true
    end
  end
  return false
end

function DikeHandler:access(conf)
  local method = kong.request.get_method()
  if not is_method_enforced(method, conf.enforce_methods) then
    return
  end

  local idem_key = kong.request.get_header(conf.header_name)
  if not idem_key or idem_key == "" then
    return
  end

  local tenant_id = "default"
  if conf.tenant_header then
    local t_hdr = kong.request.get_header(conf.tenant_header)
    if t_hdr and t_hdr ~= "" then
      tenant_id = t_hdr
    end
  end

  local raw_body = kong.request.get_raw_body() or ""
  local path = kong.request.get_path()

  -- Stash in ngx.ctx for subsequent phases
  ngx.ctx.dike = {
    idempotency_key = idem_key,
    tenant_id = tenant_id,
    method = method,
    path = path,
    response_body_chunks = {},
    status = "MISS",
  }

  -- Query DIKE control plane / Redis cluster
  local client = http.new()
  client:set_timeout(conf.timeout_ms or 2000)

  local check_url = conf.dike_upstream_url .. "/v1/idempotency/check"
  local check_payload = cjson.encode({
    tenant_id = tenant_id,
    idempotency_key = idem_key,
    method = method,
    path = path,
    payload_hash = ngx.sha256_bin(method .. "\n" .. path .. "\n" .. raw_body),
  })

  local res, err = client:request_uri(check_url, {
    method = "POST",
    headers = {
      ["Content-Type"] = "application/json",
      ["User-Agent"] = "kong-plugin-dike/" .. DikeHandler.VERSION,
    },
    body = check_payload,
  })

  if not res then
    kong.log.err("Failed to connect to DIKE upstream: ", err)
    if conf.fail_open then
      kong.log.warn("Failing open; proxying request directly to upstream")
      return
    else
      return kong.response.exit(503, {
        type = "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/503",
        title = "Service Unavailable",
        status = 503,
        detail = "Idempotency engine unreachable",
      }, { ["Content-Type"] = "application/problem+json" })
    end
  end

  if res.status == 200 then
    local data = cjson.decode(res.body)
    if data and data.status == "Hit" then
      ngx.ctx.dike.status = "HIT"
      local out_headers = data.cached_headers or {}
      out_headers["Idempotency-Status"] = "HIT"
      out_headers["X-Dike-Kong-Processed"] = "true"
      out_headers["Content-Type"] = out_headers["Content-Type"] or out_headers["content-type"] or "application/json"

      return kong.response.exit(data.cached_status_code or 200, data.cached_body or "", out_headers)
    elseif data and data.status == "Mismatch" then
      return kong.response.exit(422, {
        type = "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/422",
        title = "Unprocessable Entity",
        status = 422,
        detail = "Idempotency-Key reuse with mutated payload fingerprint",
      }, {
        ["Content-Type"] = "application/problem+json",
        ["Idempotency-Status"] = "MISMATCH",
      })
    end
    -- Status is 'Acquired', proceed upstream
    ngx.ctx.dike.status = "ACQUIRED"
  end
end

function DikeHandler:header_filter(conf)
  if not ngx.ctx.dike or not ngx.ctx.dike.idempotency_key then
    return
  end

  kong.response.set_header("X-Dike-Kong-Processed", "true")
  if ngx.ctx.dike.status == "ACQUIRED" then
    kong.response.set_header("Idempotency-Status", "MISS")
  end
end

function DikeHandler:body_filter(conf)
  if not ngx.ctx.dike or not ngx.ctx.dike.idempotency_key or ngx.ctx.dike.status ~= "ACQUIRED" then
    return
  end

  local chunk, eof = ngx.arg[1], ngx.arg[2]
  if chunk and #chunk > 0 then
    table.insert(ngx.ctx.dike.response_body_chunks, chunk)
  end

  if eof then
    ngx.ctx.dike.full_response_body = table.concat(ngx.ctx.dike.response_body_chunks)
  end
end

function DikeHandler:log(conf)
  if not ngx.ctx.dike or not ngx.ctx.dike.idempotency_key or ngx.ctx.dike.status ~= "ACQUIRED" then
    return
  end

  local resp_status = kong.response.get_status()
  -- Only persist 2xx and 4xx mutations
  if resp_status >= 500 then
    return
  end

  local commit_url = conf.dike_upstream_url .. "/v1/idempotency/commit"
  local commit_payload = cjson.encode({
    tenant_id = ngx.ctx.dike.tenant_id,
    idempotency_key = ngx.ctx.dike.idempotency_key,
    status_code = resp_status,
    headers = kong.response.get_headers(),
    body = ngx.ctx.dike.full_response_body or "",
  })

  -- Dispatch async HTTP call in ngx timer or worker pool
  local ok, err = ngx.timer.at(0, function(premature)
    if premature then return end
    local client = http.new()
    client:set_timeout(1000)
    client:request_uri(commit_url, {
      method = "POST",
      headers = { ["Content-Type"] = "application/json" },
      body = commit_payload,
    })
  end)

  if not ok then
    kong.log.err("Failed to schedule async commit timer: ", err)
  end
end

return DikeHandler
