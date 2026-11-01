local typedefs = require("kong.db.schema.typedefs")

return {
  name = "dike",
  fields = {
    { consumer = typedefs.no_consumer },
    { protocols = typedefs.protocols_http },
    {
      config = {
        type = "record",
        fields = {
          {
            header_name = {
              type = "string",
              default = "Idempotency-Key",
              required = true,
            },
          },
          {
            tenant_header = {
              type = "string",
              default = "X-Tenant-Id",
              required = false,
            },
          },
          {
            dike_upstream_url = {
              type = "string",
              default = "http://dike-service:8080",
              required = true,
            },
          },
          {
            timeout_ms = {
              type = "number",
              default = 2000,
              between = { 100, 30000 },
            },
          },
          {
            fail_open = {
              type = "boolean",
              default = true,
            },
          },
          {
            enforce_methods = {
              type = "array",
              elements = { type = "string" },
              default = { "POST", "PATCH", "PUT" },
            },
          },
        },
      },
    },
  },
}
