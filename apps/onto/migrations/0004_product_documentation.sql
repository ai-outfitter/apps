-- Refresh untouched package documentation after Product consolidation.
-- Exact prior-body matching preserves every authored definition.
UPDATE graph_types
SET body = '## What a technology is

A technology is software, a framework, a protocol, a service, hardware or another technical dependency worth documenting independently of a project.

Describe its purpose, important technical details, references, constraints and evidence of use. Use Product for a named software product and PhysicalComponent for a physical component when those descriptions fit.

## Example

Apple Health is a software product; HealthKit is a separate developer framework. A research project can document a proposed `uses` connection to Apple Health without asserting an operational HealthKit integration.

## For agents

Read the technology page and dependency evidence before building a connector or workflow. Preserve proposed versus observed status. A graph connection supplies context; execution and credentials come from the approved platform capabilities.',
    revision = revision + 1,
    updatedBy = 'migration:product-documentation',
    updatedAt = unixepoch() * 1000
WHERE id = '71000000-0000-4000-8000-000000000007'
  AND body = '## What a technology is

A technology is software, a framework, a protocol, a service, hardware or another technical dependency worth documenting independently of a project.

Describe its purpose, important technical details, references, constraints and evidence of use. Use SoftwareProduct for a named software product and PhysicalComponent for a physical component when those descriptions fit.

## Example

Apple Health is a software product; HealthKit is a separate developer framework. A research project can document a proposed `uses` connection to Apple Health without asserting an operational HealthKit integration.

## For agents

Read the technology page and dependency evidence before building a connector or workflow. Preserve proposed versus observed status. A graph connection supplies context; execution and credentials come from the approved platform capabilities.'
  AND updatedBy = 'seed:types-v1';
--> statement-breakpoint
UPDATE graph_types
SET body = '## Products

A product is an identifiable output of a project, such as a software application, sensor platform, consumer device or service. Keep its specifications, interfaces and usage documentation here. The project describes the work that creates and maintains it.

Connect the project to its product with `produces`. Connect a consuming project or product to another product with `uses`. For example, a sensor-development project produces a sensor platform, and a consumer product proposes using that platform.

## For agents

Keep project and product identities separate. Follow the producing project for work and ownership context. A produces or uses relationship records intent unless evidence establishes delivery or operational use.',
    revision = revision + 1,
    updatedBy = 'migration:product-documentation',
    updatedAt = unixepoch() * 1000
WHERE id = '71000000-0000-4000-8000-000000000015'
  AND body = '## Products

A product is an identifiable output of a project, such as a sensor platform, consumer device or service. Keep its specifications, interfaces and usage documentation here. The project describes the work that creates and maintains it.

Connect the project to its product with `produces`. Connect a consuming project or product to another product with `uses`. For example, a sensor-development project produces a sensor platform, and a consumer product proposes using that platform.

## For agents

Keep project and product identities separate. Follow the producing project for work and ownership context. A produces or uses relationship records intent unless evidence establishes delivery or operational use.'
  AND updatedBy = 'seed:types-v1';
--> statement-breakpoint
UPDATE graph_types
SET body = 'The source Offering packages the target Product.

## For agents

The offering holds commercial terms; the product holds technical identity. Do not duplicate the product for each customer or price.',
    revision = revision + 1,
    updatedBy = 'migration:product-documentation',
    updatedAt = unixepoch() * 1000
WHERE id = '71000000-0000-4000-8000-000000000057'
  AND body = 'The source Offering packages the target Product or SoftwareProduct.

## For agents

The offering holds commercial terms; the product holds technical identity. Do not duplicate the product for each customer or price.'
  AND updatedBy = 'seed:types-v1';
