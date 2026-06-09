module.exports = {
  apps: [
    {
      name: "halo-xero",
      script: "/opt/halo-xero-widget/server.js",
      cwd: "/opt/halo-xero-widget",
      time: true,
      env: { NODE_ENV: "production" }
    },
    {
      name: "halo-xero-admin",
      script: "/opt/halo-xero-widget/server-admin.js",
      cwd: "/opt/halo-xero-widget",
      time: true,
      env: { NODE_ENV: "production" }
    }
  ]
};
