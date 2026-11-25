# Synthetic Keystone native-apple/charts

The iOS and macOS apps render and preview Grafana dashboard definitions through the shared Charts module. Dashboard manifests carry a UID, title and panel list. They may include datasource placeholders which resolve against the current installation.

The fixture describes an import preview and an install action. Preview never changes the saved dashboard. Install persists a valid dashboard and provides a local error when the manifest is invalid or storage fails. The repository contains no Grafana credentials, deployed dashboards or production data.

The test-only repository marker is KEYSTONE_CHARTS_FIXTURE.

The service catalog describes Forgejo and Grafana charts and standard Grafana dashboard provisioning.
