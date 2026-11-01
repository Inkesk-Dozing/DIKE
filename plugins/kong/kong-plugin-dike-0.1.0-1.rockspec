package = "kong-plugin-dike"
version = "0.1.0-1"

source = {
  url = "git+https://github.com/Inkesk-Dozing/DIKE.git",
  branch = "main",
}

description = {
  summary = "High-performance distributed idempotency key gateway plugin for Kong",
  detailed = [[
    DIKE provides inline atomic idempotency key enforcement, locking, and
    cached response short-circuiting natively inside Kong Gateway.
  ]],
  homepage = "https://github.com/Inkesk-Dozing/DIKE",
  license = "Apache 2.0",
}

dependencies = {
  "lua >= 5.1",
  "lua-resty-http >= 0.16",
}

build = {
  type = "builtin",
  modules = {
    ["kong.plugins.dike.handler"] = "handler.lua",
    ["kong.plugins.dike.schema"] = "schema.lua",
  },
}
