# Keystone cluster configuration (synthetic)

KEYSTONE_CLUSTER_FIXTURE represents the consuming cluster configuration. It pins the OS flake and chart versions and reconciles desired service state. Acceptance needs healthy Forgejo and Grafana workloads, durable volumes, routing, provisioned dashboards and a reversible upgrade on a disposable cluster. No real manifests or credentials are included.
