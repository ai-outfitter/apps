CREATE TABLE `graph_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`pageId` text NOT NULL,
	`key` text NOT NULL,
	`filename` text NOT NULL,
	`contentType` text NOT NULL,
	`size` integer NOT NULL,
	`createdBy` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`pageId`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_assets_key_unique` ON `graph_assets` (`key`);--> statement-breakpoint
CREATE TABLE `graph_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`typeId` text NOT NULL,
	`fromId` text NOT NULL,
	`toId` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`properties` text DEFAULT '{}' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text,
	`updatedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`typeId`) REFERENCES `graph_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fromId`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`toId`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `graph_edges_from_idx` ON `graph_edges` (`fromId`);--> statement-breakpoint
CREATE INDEX `graph_edges_to_idx` ON `graph_edges` (`toId`);--> statement-breakpoint
CREATE UNIQUE INDEX `graph_edge_identity_idx` ON `graph_edges` (`typeId`,`fromId`,`toId`);--> statement-breakpoint
CREATE TABLE `graph_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`typeId` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`website` text,
	`properties` text DEFAULT '{}' NOT NULL,
	`source` text,
	`externalProvider` text,
	`externalId` text,
	`privateData` text DEFAULT '{}' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text,
	`updatedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`typeId`) REFERENCES `graph_types`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_nodes_slug_unique` ON `graph_nodes` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `graph_nodes_source_idx` ON `graph_nodes` (`source`);--> statement-breakpoint
CREATE UNIQUE INDEX `graph_nodes_external_identity_idx` ON `graph_nodes` (`externalProvider`,`externalId`);--> statement-breakpoint
CREATE INDEX `graph_nodes_type_idx` ON `graph_nodes` (`typeId`);--> statement-breakpoint
CREATE TABLE `graph_types` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`properties` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`seedVersion` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`createdBy` text,
	`updatedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `graph_types_name_unique` ON `graph_types` (`name`);
--> statement-breakpoint
-- Generated defaults from seeds/types-v1.json; do not edit below this line.
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000013','node','Entity','Entities','## Graph building blocks

An entity is an identifiable thing that people and agents need shared context about. Its stable ID is its identity; its name and documentation can change.

The graph has four building blocks:
- **Types** explain what a kind of entity or connection means and which properties it accepts.
- **Entities** are the actual projects, people, organizations, technologies, goals and documents. Each has a type, a stable ID and Markdown documentation.
- **Connections** are named, directed statements between two entities. They can carry notes, evidence and a status such as proposed.
- **Attachments** are files associated with an entity; their metadata and bytes have separate storage.

A type page explains a category. It is not an instance of that category. For example, Projects explains what a project is; a named research effort has its own page and a canonical Planning record.

## For agents

Discover the installed graph''s types through `graph-type`, then read `graph-node` and `graph-edge` records. Use stable references and current revisions for changes. Read the relevant type documentation before creating context. A connection never grants permission to act. Advanced SemLang reasoning and analytics are future work.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000001','node','Organization','Organizations','## What an organization is

An organization is a company, institution or other identifiable group. Document what it does, its public references and its relationship to the work.

Business units are recorded separately when a team or department needs its own context. Organization and business-unit pages can connect to projects, people, agents and technologies.

## Example

Apple is an organization. Apple Health can have a `developed_by` connection to Apple. This does not imply that Apple owns projects which use Apple Health.

## For agents

Read the organization''s documented scope and relevant connections. Graph membership is shared context, not an account permission, financial authorization or legal assertion.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000002','node','BusinessUnit','Business Unit','## Business units

A business unit is a team, department or area of work such as Life Sciences. Record its purpose, responsibilities and how its projects contribute to outcomes.

Connect projects with `belongs_to_unit` and people or agents through the projects they participate in. A unit can later support a community, but this record does not create community membership or permissions.

## For agents

Use the unit''s documented scope to understand project priorities. Authority to change apps or run workflows is checked separately.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000003','node','Project','Projects','## What a project is

A project is a bounded effort toward an outcome. Use its page to explain the problem, desired result, scope, decisions and current evidence.

## What belongs on the page

Record readable Markdown documentation and connect the project to its business unit, human or agent participants, technology dependencies and goals. Distinguish proposed dependencies from operational integrations.

The canonical project belongs to Planning. **Create/link project** creates or selects that record and opens its shared-context page in one flow. The graph stores its `{installationId, type, id}` reference rather than creating a competing project identity.

## Example

A health-data research project may have a proposed `uses` connection to a health platform. That connection documents intent; it does not prove a working connector.

## For agents

Read the canonical Planning record and this context page before work. Update the appropriate record through its app''s entity operations, preserve the canonical reference and use the latest revision. Add decisions, evidence and progress to the documentation rather than claiming unsupported completion.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000005','node','Person','People','## What a person is

A person is a real human involved in the work. This page explains the People section; each actual person has a separate entity page.

## Identity and privacy

Two people may have the same name. Keep separate stable IDs and do not merge records using a name alone. Sources publish people through stable record references; Wiki notes remain independent of the source.

## For agents

Use the person''s stable ID, documented responsibilities and project connections. A Person page is not proof of an authenticated account or consent to contact them. Confirm identity and permission through the relevant platform or connector before taking action.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000006','node','Agent','Agent','## Agents

An agent is a software participant, local or resident. Document its purpose, responsibilities, operating boundaries and links to projects.

This entity describes the agent; it does not provision a runtime, verify its identity or grant credentials. Use project participation and reporting connections as context.

## For agents

Read your assigned project, its business unit, relevant people, dependencies and goals before acting. Only use connectors and workflows permitted by the platform. Record evidence of progress and ask for required human decisions.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000007','node','Technology','Technologies','## What a technology is

A technology is software, a framework, a protocol, a service, hardware or another technical dependency worth documenting independently of a project.

Describe its purpose, important technical details, references, constraints and evidence of use. Use SoftwareProduct for a named software product and PhysicalComponent for a physical component when those descriptions fit.

## Example

Apple Health is a software product; HealthKit is a separate developer framework. A research project can document a proposed `uses` connection to Apple Health without asserting an operational HealthKit integration.

## For agents

Read the technology page and dependency evidence before building a connector or workflow. Preserve proposed versus observed status. A graph connection supplies context; execution and credentials come from the approved platform capabilities.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000008','node','SoftwareProduct','Software Product','## Software products

A named software product or service with its own purpose and documentation. Record public references, constraints and evidence of integration on its page.

Apple Health is a software product. Its producing organization can be connected with `developed_by`; a project can connect to it with `uses`.

## For agents

Keep a product distinct from its underlying frameworks and protocols. Document proposed use separately from tested behavior and production activation.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000009','node','PhysicalComponent','Physical Component','## Physical components

A physical part or component design relevant to a project. Document specifications, drawings, interfaces, evidence and practical constraints.

Designers, manufacturers and suppliers may be different organizations. Use the corresponding connections without assuming that one implies the others.

## For agents

Distinguish design intent, simulation, manufactured parts and measured physical behavior. Link evidence for compatibility and performance claims.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000010','node','Goal','Goal','## Goals

A goal describes a desired outcome. Document the result, accountable owner, target, time period and evidence that will determine progress.

Connect projects or participants using `pursues`. Connect a measurement definition using `measured_by` when the evaluation method is known.

## For agents

Use goals to choose useful work and report evidence. A goal page alone does not schedule a workflow or establish that the result has been achieved.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000011','node','MetricDefinition','Metric Definition','## Metric definitions

A metric definition explains how progress is measured: meaning, calculation, units, source, reporting interval and limitations.

It describes a measurement method. Actual observations and computed analytics are separate work; the existence of this page is not a measured result.

## For agents

Read the definition before interpreting a KPI. Report the period, source and evidence with any value. Future SemLang/Malloy integration may turn suitable definitions and observations into analytical queries.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000012','node','Document','Document','## Documents

A document is written context that needs its own stable identity, such as a decision, technical guide or evidence summary. Entity pages can also contain Markdown directly.

Use `documents` to connect a document to what it describes. A document about a project does not replace the canonical Planning project.

## For agents

Preserve provenance, references and authored conclusions. Separate evidence, assumptions and proposed decisions.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000021','edge','belongs_to_unit','belongs to unit','Source project or unit belongs to the target business unit. No access grant is implied.

## For agents

Read this statement from its source entity to its target entity. Preserve the stable endpoint IDs and record supporting notes or evidence. Use proposed status when a connection has not been verified. The statement grants no execution permission.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000022','edge','participant','Participant','## Participation

The source Person or Agent is a participant in the target project or organization. This is a relationship, not a separate kind of person.

## For agents

Read this edge from the person or agent to the project or organization. Record responsibilities and evidence in the edge notes. Participation does not grant permissions.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000023','edge','reports_to','reports to','Source participant reports to target participant. This is not an authentication relationship.

## For agents

Read this statement from its source entity to its target entity. Preserve the stable endpoint IDs and record supporting notes or evidence. Use proposed status when a connection has not been verified. The statement grants no execution permission.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000024','edge','uses','uses','The source project, product or organization uses or proposes using the target product or technology. State proposed until implementation and operational evidence establish otherwise.

## For agents

Read this statement from its source entity to its target entity. Preserve the stable endpoint IDs and record supporting notes or evidence. Use proposed status when a connection has not been verified. The statement grants no execution permission.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000025','edge','developed_by','developed by','Source software product was developed by target organization or participant. This does not transfer ownership to projects that use it.

## For agents

Read this statement from its source entity to its target entity. Preserve the stable endpoint IDs and record supporting notes or evidence. Use proposed status when a connection has not been verified. The statement grants no execution permission.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000026','edge','designed_by','designed by','The source project, product or technology is designed by the target organization, person or agent.

## For agents

Read this statement from its source entity to its target entity. Preserve the stable endpoint IDs and record supporting notes or evidence. Use proposed status when a connection has not been verified. The statement grants no execution permission.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000027','edge','manufactured_by','manufactured by','Source physical component is manufactured by target organization.

## For agents

Read this statement from its source entity to its target entity. Preserve the stable endpoint IDs and record supporting notes or evidence. Use proposed status when a connection has not been verified. The statement grants no execution permission.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000028','edge','supplied_by','supplied by','Source technology is supplied by target organization. Supplying does not imply designing or manufacturing.

## For agents

Read this statement from its source entity to its target entity. Preserve the stable endpoint IDs and record supporting notes or evidence. Use proposed status when a connection has not been verified. The statement grants no execution permission.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000029','edge','pursues','pursues','The source project, organization, person or agent pursues the target goal.

## For agents

Read this statement from its source entity to its target entity. Preserve the stable endpoint IDs and record supporting notes or evidence. Use proposed status when a connection has not been verified. The statement grants no execution permission.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000030','edge','measured_by','measured by','## Measurement relationships

A goal, customer problem, project or organization is evaluated with a metric definition. A metric definition can in turn link to its measurement instrument or data source, such as a sensor platform.

## For agents

Read the metric definition for units, scope, targets and reporting periods. A target is not an observed value. A link to an instrument does not prove a working integration; distinguish intended sources from verified observations.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000031','edge','documents','documents','Source document describes target node. It does not replace that node or its canonical source.

## For agents

Read this statement from its source entity to its target entity. Preserve the stable endpoint IDs and record supporting notes or evidence. Use proposed status when a connection has not been verified. The statement grants no execution permission.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000032','edge','part_of','part of','## Organizational context

The source project is part of the target organization. Use this to group an organization’s projects without confusing the organization with an individual project.

## For agents

Follow this edge from a project to its organization for shared context. This relationship does not grant access or assert legal ownership.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000014','node','Repository','Repositories','## Source repositories

A version-control repository stores source code. Use one entity for the whole repository, with its repository URL in Website. Multiple projects can link to different directories in the same repository.

## For agents

Follow a project’s `source_in` relationship. An empty path means the whole repository; a non-empty path identifies its code within a monorepo. The ref identifies a branch, tag or commit. Repository context does not grant access.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000033','edge','source_in','source in','## Project source

The source project has code in the target Repository. The optional path scopes the project to a directory inside a monorepo; an empty path means the entire repository.

## For agents

Use the repository URL together with this edge’s path and ref. Several projects may share the same repository with different paths. Preserve the distinction between a project and its repository.','[{"name":"path","type":"string","description":"Repository-relative directory; empty for the whole repository.","required":false},{"name":"ref","type":"string","description":"Branch, tag or commit used for browsing source.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000034','edge','collects_telemetry_from','collects telemetry from','The source project collects telemetry produced by the target platform or project.

## For agents

Use this relationship to find the data source and the project responsible for collecting it. Consult their documentation for schemas, transport and deployment status.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000015','node','Product','Products','## Products

A product is an identifiable output of a project, such as a sensor platform, consumer device or service. Keep its specifications, interfaces and usage documentation here. The project describes the work that creates and maintains it.

Connect the project to its product with `produces`. Connect a consuming project or product to another product with `uses`. For example, a sensor-development project produces a sensor platform, and a consumer product proposes using that platform.

## For agents

Keep project and product identities separate. Follow the producing project for work and ownership context. A produces or uses relationship records intent unless evidence establishes delivery or operational use.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000035','edge','produces','produces','## Project outputs

The source project creates or maintains the target product. This separates the work from the output other projects and products can use.

## For agents

Follow this edge from project to product. Record proposed status for planned outputs; the relationship alone does not establish that a product has shipped or is operational.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000016','node','CustomerSegment','Customer segments','## Customer segments

A group of prospective or existing customers with shared needs, such as commercial spaces with indoor plants or home plant owners. A segment is not an individual organization.

## For agents

Use `in_segment` to connect people or organizations to the segment, and `experiences` to connect it to shared customer problems. A proposed `customer_of` relationship describes an intended market, not a signed customer.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000017','node','Problem','Customer problems','## Customer problems

A need or difficulty experienced by customers. Keep one shared problem when several segments experience the same need. Document the desired outcome and gaps in current measurement.

## For agents

Use `experiences` from a customer or segment to this problem, `addresses` from a project or product to the problem, and `measured_by` to link relevant success metrics. A coverage metric such as monitored plants does not alone prove plant health or problem resolution.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000036','edge','customer_of','customer of','The source person, organization or customer segment is a customer or prospective customer of the target provider organization or project.

## For agents

Direction is customer to provider. Use proposed status for target customers or hypotheses; never infer contracts, purchases or endorsements from this relationship.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000037','edge','in_segment','in segment','The source person or organization belongs to the target customer segment.

## For agents

Segment membership describes shared needs and is separate from an established customer relationship. Preserve proposed status when unvalidated.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000038','edge','experiences','experiences','The source customer or customer segment experiences the target problem.

## For agents

Reuse shared problem entities across segments. Record proposed status until customer research supports the problem statement.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000039','edge','addresses','addresses','The source project, product or organization aims to address the target customer problem.

## For agents

Follow the problem’s measured_by relationships for evaluation. Proposed solutions and monitoring coverage are not evidence that the customer problem has been solved.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000040','edge','integrates_with','integrates with','## Product integration

The source technology connects or is intended to connect with the target technology. This is separate from who develops either product.

## For agents

Use status and evidence to distinguish an intended integration from verified operational behavior. This relationship does not install a connector or grant access.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000018','node','Role','Roles','## Roles

A reusable responsibility such as CEO, CPO, CFO, CTO or Senior Software Engineer. A role describes responsibilities; it is separate from the person or agent holding it and from the organization where it applies.

## For agents

Find RoleAssignment entities linked to this role through `assigns_role`. Do not infer permissions or runtime provisioning from the role name.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000019','node','RoleAssignment','Role assignments','## Role assignments

A role assignment joins one Person or Agent, one Role, and one organization or other work scope. Separate assignments allow one holder to have multiple roles and preserve organization-specific agent identities.

Use `assigned_to` for the holder, `assigns_role` for the role, and `scoped_to` for its organization.

## For agents

Read all three relationships together. Missing links mean incomplete context. An assignment documents responsibility and does not grant application permissions, deploy a resident agent or configure reporting lines.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000041','edge','assigned_to','assigned to','The source RoleAssignment is held by the target Person or Agent.

## For agents

Preserve the holder’s stable identity. Different organization-specific agents may share a display name but must remain separate entities.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000042','edge','assigns_role','assigns role','The source RoleAssignment assigns the target Role.

## For agents

Read the assignment’s holder and scope to understand where this role applies. Multiple roles require separate assignments.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000043','edge','scoped_to','scoped to','The source RoleAssignment or DecisionRecord applies within the target organization, business unit or project.

## For agents

Read the scope before using role or decision context. A title held in one organization does not carry over to another organization.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000050','node','DecisionType','Decision types','## Decision types

A named kind of decision, such as Approve Release. It describes what may be decided, not an approval of a particular release.

## For agents

Follow incoming `permits` relationships to authority definitions. Concrete DecisionRecords link here with `decision_type`. Execution permissions and enforcement remain outside this context graph.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000051','node','AuthorityDefinition','Authority definitions','## Authority definitions

A reusable definition of decision authority. Its `permits` relationships identify the decision types it covers.

## For agents

An AuthorityGrant points here with `defined_by`. Read the grant’s role and the holder’s RoleAssignment scope together. This record describes authority; it is not a platform permission.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000052','node','AuthorityGrant','Authority grants','## Authority grants

A grant gives a role the authority described by one AuthorityDefinition. Follow `has_authority_grant` from Role to grant, then `defined_by` to its definition and `permits` to DecisionType.

## Scope

A holder’s authority applies in the organization of their RoleAssignment. An unscoped or incomplete assignment does not establish scoped authority. Archived grants do not contribute current authority.

## For agents

This is documented decision authority, not executable authorization. Release workflows still require their own permissions and approval checks.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000053','edge','has_authority_grant','has authority grant','The source Role holds the target AuthorityGrant.

## For agents

Combine the role’s grant with a holder’s explicit RoleAssignment scope. Never infer cross-organization authority from a shared role name.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000054','edge','defined_by','defined by','The source AuthorityGrant is defined by the target AuthorityDefinition.

## For agents

Read the authority definition’s permitted DecisionTypes; the grant alone does not approve any concrete action.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000055','edge','permits','permits','The source AuthorityDefinition permits the target DecisionType.

## For agents

This relationship documents a permitted kind of decision. It is not an actual decision, release approval or deployed permission check.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000056','node','Offering','Offerings','## Offerings

An offering packages and prices a product for customers. The product is the reusable thing; the offering describes what a customer can obtain and its commercial terms. Multiple offerings may package the same product differently.

Use `packages_product` to identify the product, `offered_by` for the provider, and `pays_for` from the customer to the offering. Omit an unknown price; zero means free, not unknown.

## For agents

Read pricing notes and the relationship status. A proposed paying-customer relationship is not an invoice, completed payment, contract or deployment.

## Pricing models

Inference may use cost_plus pricing: provider cost plus a markup. Resident-agent offerings may use role_based pricing, with priced_by_role edges carrying optional per-role prices. Missing rates remain unspecified; do not infer free usage.','[{"name":"price","type":"number","description":"Explicit price when known; omit if not specified.","required":false},{"name":"currency","type":"string","description":"Currency code for the stated price.","required":false},{"name":"billing_interval","type":"string","description":"One-time, monthly, usage-based or other stated interval.","required":false},{"name":"pricing_notes","type":"string","description":"Commercial terms, scope and unresolved pricing details.","required":false},{"name":"pricing_model","type":"string","description":"Commercial pricing basis, such as cost_plus or role_based.","required":false},{"name":"markup_percent","type":"number","description":"Explicit percentage added to provider cost; omit when not specified.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000057','edge','packages_product','packages product','The source Offering packages the target Product or SoftwareProduct.

## For agents

The offering holds commercial terms; the product holds technical identity. Do not duplicate the product for each customer or price.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000058','edge','offered_by','offered by','The source Offering is offered by the target organization.

## For agents

Offering a product does not imply manufacturing or designing it; follow those relationships separately.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000059','edge','pays_for','pays for','The source customer organization or person pays or intends to pay for the target Offering.

## For agents

Use proposed status for a planned commercial relationship. Read the offering for package and pricing terms. This edge is not proof of a settled payment.','[{"name":"status","type":"string","description":"Evidence status, for example proposed, documented, observed or retired.","required":false},{"name":"evidence","type":"string","description":"Source URL or explanation supporting this statement; not proof of operational integration.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000060','edge','priced_by_role','priced by role','The source Offering has a pricing tier based on the target Role. Optional edge properties describe that role’s price and billing interval.

## For agents

This is a commercial rate relationship, not a role assignment or authority grant. An omitted price is unknown, not zero.','[{"name":"price","type":"number","description":"Explicit rate for this role; omit when unspecified.","required":false},{"name":"currency","type":"string","description":"Currency for this role rate.","required":false},{"name":"billing_interval","type":"string","description":"Billing interval or unit for this role rate.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000061','node','DecisionRecord','Decision records','## Decision records

A concrete decision made by a person or agent, distinct from the kind of decision they may make. Document the decision and rationale in Markdown. Link its DecisionType with `decision_type`, its maker with `made_by`, the RoleAssignment used with `under_assignment`, and the organization or project with `scoped_to`. Use `establishes` for goals set by the decision.

## For agents

Read the maker, assignment, scope and authority chain together. This is recorded context, not an executable authorization or a tamper-proof audit log. Preserve historical records when roles change; a current role assignment alone cannot prove historical authority. A goal-setting decision does not prove goal completion.','[{"name":"status","type":"string","description":"Decision state, such as proposed, decided or superseded.","required":false}]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000062','edge','decision_type','decision type','The source DecisionRecord is an instance of the target DecisionType.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000063','edge','made_by','made by','The source DecisionRecord was made by the target Person or Agent.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000064','edge','under_assignment','under assignment','The source DecisionRecord was made in the capacity of the target RoleAssignment. Preserve this historical link if the assignment later ends.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_types ("id","category","name","title","body","properties","archived","seedVersion","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('71000000-0000-4000-8000-000000000065','edge','establishes','establishes','The source DecisionRecord establishes the target goal. Read the decision rationale, organization scope and the goal’s measured_by links.','[]',0,1,1,'seed:types-v1','seed:types-v1',1792886400000,1792886400000);
--> statement-breakpoint
-- Generated entities from seeds/entities-v1.json.
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('73000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','outfitter','Outfitter','Shared organization context for Outfitter.','## Purpose

Organization context for Outfitter projects, people, technologies and agents.

## For agents

Link relevant projects and business units to this organization. Record verified context and distinguish proposed work from completed outcomes. This page does not grant permissions.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('73000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000001','unsupervised','Unsupervised','Shared organization context for Unsupervised.','## Purpose

Organization context for Unsupervised projects, people, technologies and agents.

## For agents

Link relevant projects and business units to this organization. Do not infer ownership, employment or relationships from a name alone. This page does not grant permissions.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('2b4793fc-272c-551f-9a47-1b9d881b7840','71000000-0000-4000-8000-000000000011','merged-pull-requests','Merged pull requests','','Count distinct pull requests merged for the project during the reporting period. Count by repository and PR number, using merge time rather than creation or approval time.

- Unit: merged pull requests
- Target: not specified
- Source: repository merge records
- Repository scope and reporting period: to be configured

No observed value has been recorded.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('319fe4a9-8c59-5e05-81c0-09e16c201cfe','71000000-0000-4000-8000-000000000011','active-users-with-a-connection','Active users with a connection','','Count distinct active Outfitter users who have at least one connected Google Gmail, Google Calendar, Slack or GitHub account. Count each user once, regardless of how many qualifying connections they have.

- Unit: users
- Qualifying connections: Google Gmail, Google Calendar, Slack, GitHub
- Target: not specified
- Activity definition and reporting window: to be specified before automated reporting
- Source: user activity and connector connection records

## Observations

This is a measurement definition; no current value has been recorded.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('5d996163-25ae-56f4-9260-de62b030436c','71000000-0000-4000-8000-000000000014','ai-outfitter-webapp-repository','ai-outfitter/webapp','','','https://github.com/ai-outfitter/webapp','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('1d9e960b-2318-52d6-ac30-7702c41e37cc','71000000-0000-4000-8000-000000000001','stripe','Stripe','Organization behind Stripe payment services.','## Stripe

Organization context for the Stripe payment technology. Link the service separately from its provider.','https://stripe.com','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('cf511077-48cf-551b-95c0-7c93592085c8','71000000-0000-4000-8000-000000000008','stripe-payments','Stripe Payments','Payment service and potential source of payment and revenue records.','## Stripe Payments

A payment service. Projects can document intended use with `uses`; metric definitions can identify it as a proposed source through `measured_by`.

A graph relationship does not configure a Stripe connector, establish accounting treatment or prove that payments have been collected.','https://stripe.com/payments','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('cafd0d91-d87f-505f-9845-934f6753c6d4','71000000-0000-4000-8000-000000000001','google','Google','Organization behind Gmail and Google Calendar.','## Google

Organization context for Gmail and Google Calendar. Product relationships are documented separately from Outfitter’s proposed use of those products.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('5f0b933f-a50c-5872-8539-caec80f3a3dc','71000000-0000-4000-8000-000000000008','gmail','Gmail','Email technology linked to Outfitter’s communication context.','## Gmail

Google email product. Outfitter’s proposed uses relationship documents email context and connector intent; it does not establish an active account connection.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('d2659273-933a-5d97-97b4-c4785cee2b20','71000000-0000-4000-8000-000000000008','google-calendar','Google Calendar','Calendar technology linked to Outfitter’s scheduling context.','## Google Calendar

Google calendar product. Its integration relationship with Gmail records scheduling and email interoperability context, separately from the Google provider relationship. Outfitter account access must be configured independently.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('9eb0c8c7-37ae-546f-97bf-9dc9b995f118','71000000-0000-4000-8000-000000000008','whatsapp','WhatsApp','Messaging technology for Outfitter’s proposed communication context.','## WhatsApp

Messaging product documented as a proposed Outfitter dependency. No connected account, installed connector or message access is implied.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('40ae5a3e-e8c4-5089-b30b-86cc5f61e50f','71000000-0000-4000-8000-000000000008','imessage','iMessage','Messaging technology for Outfitter’s communication context.','## iMessage

Messaging product documented as an Outfitter dependency. Availability and account access depend on separately configured connectors; this page does not establish operational access.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('9acacda9-3882-5126-83fd-4db358013131','71000000-0000-4000-8000-000000000001','linq','Linq','Provider of a messaging API with iMessage support.','## Linq

Linq provides messaging APIs, including iMessage support, according to its [website](https://linqapp.com). Keep the provider separate from the Linq Messaging API technology and from iMessage itself.','https://linqapp.com','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('c2a3b7ad-8122-52d9-9a23-6b3ed286383b','71000000-0000-4000-8000-000000000008','linq-messaging-api','Linq Messaging API','Messaging API offering iMessage access; a proposed integration option for Outfitter.','## Messaging API

Linq advertises API access to iMessage, RCS and SMS on its [website](https://linqapp.com). See the [API documentation](https://docs.linqapp.com).

## Outfitter context

Proposed provider for Outfitter’s iMessage connector. Outfitter uses Linq Messaging API, which integrates with iMessage. This records an integration option, not an installed connector, configured account or verified message delivery.','https://docs.linqapp.com','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('f1fa1826-8521-58cb-ba9d-60658e672a25','71000000-0000-4000-8000-000000000018','ceo','Chief Executive Officer (CEO)','Responsible for overall organizational direction, priorities and executive coordination.','## Responsibilities

Responsible for overall organizational direction, priorities and executive coordination.

See role assignments for the holder and organizational scope.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('124e09f2-3724-5a4e-9eda-bcd9bf8837b0','71000000-0000-4000-8000-000000000018','cpo','Chief Product Officer (CPO)','Responsible for product strategy, customer needs and product outcomes.','## Responsibilities

Responsible for product strategy, customer needs and product outcomes.

See role assignments for the holder and organizational scope.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('1b7e533a-1ed8-55a8-8acf-3c0610c1b36e','71000000-0000-4000-8000-000000000018','cfo','Chief Financial Officer (CFO)','Responsible for financial planning, measurement and stewardship.','## Responsibilities

Responsible for financial planning, measurement and stewardship.

See role assignments for the holder and organizational scope.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('46d20661-b4a0-52ec-a1c3-0a6fdea9506d','71000000-0000-4000-8000-000000000018','cto','Chief Technology Officer (CTO)','Responsible for technology strategy, architecture and technical direction.','## Responsibilities

Responsible for technology strategy, architecture and technical direction.

See role assignments for the holder and organizational scope.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('8d790222-eee9-552c-8efa-786a1ceafbe8','71000000-0000-4000-8000-000000000018','senior-software-engineer','Senior Software Engineer','Responsible for software design, implementation, technical quality and engineering delivery.','## Responsibilities

Responsible for software design, implementation, technical quality and engineering delivery.

See role assignments for the holder and organizational scope.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('4aa974f1-e369-5dee-a237-74058aed41e5','71000000-0000-4000-8000-000000000018','vp-flight-systems','VP of Flight Systems','Responsible for flight systems leadership and coordination.','## Responsibilities

Leads flight systems work and coordinates its technical direction and delivery. See role assignments for the holder and organizational scope.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('1366e2f2-2e52-5b38-9dd7-7ca2e34966c9','71000000-0000-4000-8000-000000000001','codeberg-ev','Codeberg e.V.','Nonprofit umbrella organization backing Forgejo development.','## Codeberg e.V.

Codeberg e.V. backs Forgejo development as its umbrella organization. Forgejo is developed by an independent community under that umbrella.

Source: [Codeberg documentation](https://docs.codeberg.org/getting-started/what-is-codeberg/).','https://codeberg.org','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('aedf2c8a-abfe-5a83-8ffa-fec114e56223','71000000-0000-4000-8000-000000000008','forgejo','Forgejo','Community-developed software forge under the umbrella of Codeberg e.V.','## Forgejo

A self-hosted software forge developed by a community under the umbrella of Codeberg e.V. The developed_by relationship records that organizational context, rather than asserting that Codeberg is the sole author.

Source: [Forgejo](https://forgejo.org/).','https://forgejo.org','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('0cdb30f1-1c29-50b2-ac5d-5679e7eeb59d','71000000-0000-4000-8000-000000000050','approve-release','Approve Release','Decide whether a release is approved.','## Approve Release

The decision to approve a release for an organization. This type is distinct from publishing or executing the release. A concrete approval and its supporting evidence must be recorded by the relevant workflow.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('90d73df2-7173-5ab9-a644-195969e68f13','71000000-0000-4000-8000-000000000051','release-approval-authority','Release approval authority','Authority to decide whether a release is approved.','## Authority

Permits the Approve Release decision type. The holder acts within the organization named by their role assignment. This does not bypass deployment permissions or existing release controls.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('0d828cc7-60ea-53a9-9a0d-5b16b72b0fee','71000000-0000-4000-8000-000000000052','cto-release-approval-grant','CTO release approval grant','Grants the CTO role release-approval decision authority.','## Grant

The CTO role receives Release approval authority. Holders inherit this documented authority only within the scope of their own role assignment. No individual release has been approved by creating this grant.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('4ad0bb73-2d12-5726-abfe-d8e23897e256','71000000-0000-4000-8000-000000000017','data-sovereignty','Data sovereignty','Control where data is stored and processed, who can access it, and which infrastructure operates it.','## Customer problem

Self-hosters and enterprises need control over where their data is stored and processed, who can access it, and the infrastructure used to operate their systems.

Outfitter aims to address this shared problem. Specific hosting, access-control and data-handling requirements must be recorded for each deployment; this problem page is not a claim that a deployment already meets them.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('e7872950-67ea-57a0-b32d-628d8478e201','71000000-0000-4000-8000-000000000016','self-hosters','Self-hosters','People and teams running software on infrastructure they control.','## Customer context

An Outfitter customer segment that values control of its own infrastructure and data. Shares the Data sovereignty problem with enterprise customers.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('ac9a2be1-7950-56b1-b148-6410b51b178d','71000000-0000-4000-8000-000000000016','enterprise','Enterprise','Organizations needing control over their data and deployment environment.','## Customer context

An Outfitter customer segment with organizational requirements for data location, processing, access and infrastructure control. Shares the Data sovereignty problem with self-hosters.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('814435fc-240b-5d69-939c-cbda37985f20','71000000-0000-4000-8000-000000000018','coo','Chief Operating Officer (COO)','Responsible for operations, organizational execution and coordination.','## Responsibilities

Coordinates organizational operations and delivery. See role assignments for the holder and organizational scope.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('5b33818e-cdd5-5309-84ea-ab42de9e6a7b','71000000-0000-4000-8000-000000000015','outfitter-inference-service','Outfitter inference service','Model inference service offered by Outfitter.','## Service

Inference used to run model requests. Its offering defines customer pricing separately from the product; no provider tariff or model price is asserted here.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('0479b761-0ce9-5412-9175-363c207db8c4','71000000-0000-4000-8000-000000000015','outfitter-resident-agent-service','Outfitter resident agent service','Resident agents performing assigned organizational roles.','## Service

Resident agents operating in assigned roles. Commercial rates are attached to the offering’s role tiers. A purchased tier does not itself assign a role or grant authority.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('43f950db-67b4-5b90-a1c8-09e79bbad23e','71000000-0000-4000-8000-000000000056','outfitter-inference-offering','Inference with markup','Inference priced as provider cost plus an Outfitter markup.','## Pricing basis

Customer inference price is provider inference cost plus Outfitter’s markup. The markup percentage, providers, models, currency and billing unit are not specified yet.',NULL,'{"pricing_model":"cost_plus","pricing_notes":"Provider cost plus markup. Markup percentage, currency and billing unit remain unspecified."}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('5933137a-324b-5dba-b677-c74dc90ca745','71000000-0000-4000-8000-000000000056','outfitter-resident-agent-offering','Role-priced resident agents','Resident-agent pricing depends on the agent’s role.','## Pricing basis

Resident-agent rates vary by role. Role tiers reference the same Role entities used for assignments; the price for each role and its billing interval remain unspecified.

Inference treatment within these tiers has not been defined. This offering does not configure billing or create resident runtimes.',NULL,'{"pricing_model":"role_based","pricing_notes":"Prices and billing intervals for each role remain unspecified."}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('dd14dec8-b7a6-5069-80f6-fe732e79607f','71000000-0000-4000-8000-000000000010','monthly-inference-revenue','10K monthly inference revenue','Reach 10,000 in inference revenue per month.','## Target

Reach 10,000 in inference revenue per month.

## Progress

See the linked metric definition for counting rules. No measured progress has been recorded.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('734f7e2d-7d1f-548c-91a5-c5896baabd66','71000000-0000-4000-8000-000000000011','monthly-inference-revenue-metric','Monthly inference revenue','','Sum inference revenue for one calendar month.

- Target: 10,000 per month
- Currency: not specified; use one configured currency and do not combine currencies without a defined conversion method
- Scope: inference revenue; resident-agent subscription fees are separate
- Source: inference billing and revenue records
- Accounting basis, refunds, tax treatment, timezone and whether the target covers total inference charges or markup revenue: to be defined

No measured value or billing integration has been recorded.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('78631eab-bef0-55bd-abef-17a05537c386','71000000-0000-4000-8000-000000000010','daily-resident-workflow-agents','10 resident agents completing a workflow daily','Each day, at least 10 distinct resident agents complete at least one workflow.','## Target

Each day, at least 10 distinct resident agents complete at least one workflow.

## Progress

See the linked metric definition for counting rules. No measured progress has been recorded.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('9bdfda47-bbc0-5f78-861e-747b19ced26a','71000000-0000-4000-8000-000000000011','daily-resident-workflow-agents-metric','Daily resident agents with a completed workflow','','Count distinct resident-agent IDs with at least one successfully completed workflow during the reporting day.

- Target: 10 agents per day
- Unit: distinct resident agents
- An agent completing several workflows counts once that day
- Queued, running, failed or cancelled workflows do not count
- Source: resident-agent identity and workflow completion records
- Reporting timezone and production/test exclusions: to be configured

No measured value or automated counter has been recorded.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('19f5e7bf-34c9-51ef-b50f-ef5c337defc3','71000000-0000-4000-8000-000000000010','reported-self-hosted-installs','10 reported self-hosted installations','Reach 10 distinct self-hosted installations reported to Outfitter.','## Target

Reach 10 distinct self-hosted installations reported to Outfitter.

## Progress

See the linked metric definition for counting rules. No measured progress has been recorded.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('3b713d9e-21f0-5728-9632-f630253cad98','71000000-0000-4000-8000-000000000011','reported-self-hosted-installs-metric','Reported self-hosted installations','','Count distinct self-hosted installations that report their installation to Outfitter.

- Target: 10 installations
- Unit: unique installation IDs, deduplicated across repeated reports
- Scope: self-hosted installations, excluding hosted Outfitter instances
- Source: voluntarily submitted installation reports
- Reporting period, test-instance exclusions and retirement handling: to be specified
- Do not estimate unreported installs or treat this definition as consent to collect telemetry

No measured value or reporting integration has been recorded.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('48f84fdf-2b2c-586d-87f1-ca0abd4cb63b','71000000-0000-4000-8000-000000000050','set-organization-goals','Set Organization Goals','Set an organization’s goals and measures of success.','## Set Organization Goals

Choose or revise the organization’s goals and success measures. Record the actual decision separately, including the deciding person, scoped role assignment, rationale and goals established.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('d355c874-dba2-50b0-ae74-989c8c1a92b8','71000000-0000-4000-8000-000000000051','organization-goal-setting-authority','Organization goal-setting authority','Authority to set goals within the role assignment’s organization.','## Authority

Permits Set Organization Goals within the organization named by the holder’s RoleAssignment. It documents decision authority, not platform access or automatic goal execution.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_nodes ("id","typeId","slug","title","summary","body","website","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('0e360076-1a6d-5347-b956-9eeca5a8663a','71000000-0000-4000-8000-000000000052','ceo-organization-goal-setting-grant','CEO organization goal-setting grant','Grants the CEO role organization goal-setting authority.','## Grant

The CEO role may set goals within its assigned organization. Read the holder and scope from the RoleAssignment.',NULL,'{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
-- Generated relationships between installation-seeded entities.
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('ca79d0e6-738a-5bb2-b186-96c0dcb90225','71000000-0000-4000-8000-000000000030','73000000-0000-4000-8000-000000000001','319fe4a9-8c59-5e05-81c0-09e16c201cfe','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('601dea20-27e8-54fb-ba58-8790517d8e22','71000000-0000-4000-8000-000000000025','cf511077-48cf-551b-95c0-7c93592085c8','1d9e960b-2318-52d6-ac30-7702c41e37cc','','Stripe provides Stripe Payments.','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('9d51954c-8206-55d1-9229-28fb8f139bd9','71000000-0000-4000-8000-000000000025','5f0b933f-a50c-5872-8539-caec80f3a3dc','cafd0d91-d87f-505f-9845-934f6753c6d4','','Product provider is Google.','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('a896b1e2-7976-5adf-87f8-5eb8c8acd4f2','71000000-0000-4000-8000-000000000025','d2659273-933a-5d97-97b4-c4785cee2b20','cafd0d91-d87f-505f-9845-934f6753c6d4','','Product provider is Google.','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('6211f9ba-9b82-55c9-a187-644ca048ce25','71000000-0000-4000-8000-000000000040','d2659273-933a-5d97-97b4-c4785cee2b20','5f0b933f-a50c-5872-8539-caec80f3a3dc','','Intended calendar/email integration context; no Outfitter account integration is asserted.','{"status":"proposed"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('e707c004-4d17-58ca-b7e3-c996fb9f580f','71000000-0000-4000-8000-000000000024','73000000-0000-4000-8000-000000000001','9eb0c8c7-37ae-546f-97bf-9dc9b995f118','','Proposed Outfitter communication or scheduling dependency; connector configuration and live access are separate.','{"status":"proposed"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('86e2e5c3-ae98-54b1-a4e1-71590a1f5daf','71000000-0000-4000-8000-000000000024','73000000-0000-4000-8000-000000000001','5f0b933f-a50c-5872-8539-caec80f3a3dc','','Proposed Outfitter communication or scheduling dependency; connector configuration and live access are separate.','{"status":"proposed"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('dd7d9548-9bf5-57af-8c50-ae7ff7353e4f','71000000-0000-4000-8000-000000000024','73000000-0000-4000-8000-000000000001','40ae5a3e-e8c4-5089-b30b-86cc5f61e50f','','Proposed Outfitter communication or scheduling dependency; connector configuration and live access are separate.','{"status":"proposed"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('b2dc64e3-80aa-5979-adab-ffada12d6e53','71000000-0000-4000-8000-000000000024','73000000-0000-4000-8000-000000000001','d2659273-933a-5d97-97b4-c4785cee2b20','','Proposed Outfitter communication or scheduling dependency; connector configuration and live access are separate.','{"status":"proposed"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('5ffc7510-c502-5a78-b204-5be17e7cd100','71000000-0000-4000-8000-000000000025','c2a3b7ad-8122-52d9-9a23-6b3ed286383b','9acacda9-3882-5126-83fd-4db358013131','','Linq provides the messaging API. Source: https://linqapp.com','{"evidence":"https://linqapp.com"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('f5aea3c1-0cc2-57e2-b71f-ae8873513b4b','71000000-0000-4000-8000-000000000040','c2a3b7ad-8122-52d9-9a23-6b3ed286383b','40ae5a3e-e8c4-5089-b30b-86cc5f61e50f','','Linq documents iMessage API support. This provider capability has not been exercised by the local Outfitter integration.','{"status":"documented","evidence":"https://linqapp.com"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('0b58464f-f906-5ba7-8c8b-12e89886f4fe','71000000-0000-4000-8000-000000000024','73000000-0000-4000-8000-000000000001','c2a3b7ad-8122-52d9-9a23-6b3ed286383b','','Proposed provider for Outfitter’s iMessage connector. No configured account or active integration is asserted.','{"status":"proposed","evidence":"https://linqapp.com"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('f4babd8a-05ec-5b9b-be20-49a61591df45','71000000-0000-4000-8000-000000000025','aedf2c8a-abfe-5a83-8ffa-fec114e56223','1366e2f2-2e52-5b38-9dd7-7ca2e34966c9','','Forgejo is community-developed under the umbrella of Codeberg e.V.; Codeberg backs development rather than being the sole author.','{"status":"documented","evidence":"https://forgejo.org/"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('3b402fdc-f7d3-5e85-9143-9b7faea0aef3','71000000-0000-4000-8000-000000000053','46d20661-b4a0-52ec-a1c3-0a6fdea9506d','0d828cc7-60ea-53a9-9a0d-5b16b72b0fee','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('5ec116d0-ec12-573d-8054-61f63225b1a4','71000000-0000-4000-8000-000000000054','0d828cc7-60ea-53a9-9a0d-5b16b72b0fee','90d73df2-7173-5ab9-a644-195969e68f13','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('93bb3a6e-a8a0-5730-93d4-b72a807048b3','71000000-0000-4000-8000-000000000055','90d73df2-7173-5ab9-a644-195969e68f13','0cdb30f1-1c29-50b2-ac5d-5679e7eeb59d','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('b79b8148-ee53-5b72-b331-edfe0eb03c56','71000000-0000-4000-8000-000000000036','e7872950-67ea-57a0-b32d-628d8478e201','73000000-0000-4000-8000-000000000001','','Intended customer segment for Outfitter.','{"status":"proposed"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('a3d4fb51-325b-53c3-82cf-30107dca7d03','71000000-0000-4000-8000-000000000038','e7872950-67ea-57a0-b32d-628d8478e201','4ad0bb73-2d12-5726-abfe-d8e23897e256','','Shared need for control over data and deployment infrastructure.','{"status":"proposed"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('29f495fa-8259-512e-825e-7601805f63cb','71000000-0000-4000-8000-000000000036','ac9a2be1-7950-56b1-b148-6410b51b178d','73000000-0000-4000-8000-000000000001','','Intended customer segment for Outfitter.','{"status":"proposed"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('61e08af9-5ade-5a24-a2d7-51c8633e0d8d','71000000-0000-4000-8000-000000000038','ac9a2be1-7950-56b1-b148-6410b51b178d','4ad0bb73-2d12-5726-abfe-d8e23897e256','','Shared need for control over data and deployment infrastructure.','{"status":"proposed"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('0a349606-a985-5db3-8b06-4880c899d033','71000000-0000-4000-8000-000000000039','73000000-0000-4000-8000-000000000001','4ad0bb73-2d12-5726-abfe-d8e23897e256','','Outfitter aims to address the shared data-sovereignty need; deployment-specific evidence remains separate.','{"status":"proposed"}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('61c381d0-2f86-501f-9b82-2ea27d44b4ee','71000000-0000-4000-8000-000000000057','43f950db-67b4-5b90-a1c8-09e79bbad23e','5b33818e-cdd5-5309-84ea-ab42de9e6a7b','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('d6c1f80b-ca54-5c0a-8e92-e131ee4052ec','71000000-0000-4000-8000-000000000058','43f950db-67b4-5b90-a1c8-09e79bbad23e','73000000-0000-4000-8000-000000000001','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('b1d9c12d-cf0c-550b-a6d0-4ee424b9c1bb','71000000-0000-4000-8000-000000000057','5933137a-324b-5dba-b677-c74dc90ca745','0479b761-0ce9-5412-9175-363c207db8c4','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('5b929697-9fde-512c-b8e4-6a266e9f714d','71000000-0000-4000-8000-000000000058','5933137a-324b-5dba-b677-c74dc90ca745','73000000-0000-4000-8000-000000000001','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('95805bc9-1a28-5b67-8dd4-388be5bf6aa7','71000000-0000-4000-8000-000000000060','5933137a-324b-5dba-b677-c74dc90ca745','124e09f2-3724-5a4e-9eda-bcd9bf8837b0','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('2771f4af-cdc5-5548-b887-91104fd635d9','71000000-0000-4000-8000-000000000060','5933137a-324b-5dba-b677-c74dc90ca745','1b7e533a-1ed8-55a8-8acf-3c0610c1b36e','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('d463f2c5-7f13-5f4b-823e-149ce1e674d6','71000000-0000-4000-8000-000000000060','5933137a-324b-5dba-b677-c74dc90ca745','814435fc-240b-5d69-939c-cbda37985f20','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('fa516549-3b9c-59d0-b9ea-9e7f2743ad99','71000000-0000-4000-8000-000000000060','5933137a-324b-5dba-b677-c74dc90ca745','46d20661-b4a0-52ec-a1c3-0a6fdea9506d','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('a4e43ee1-4253-5ec5-8850-1e5c578ccab6','71000000-0000-4000-8000-000000000060','5933137a-324b-5dba-b677-c74dc90ca745','8d790222-eee9-552c-8efa-786a1ceafbe8','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('d59aa0fd-b097-5f8b-942b-aefcc21332ac','71000000-0000-4000-8000-000000000029','73000000-0000-4000-8000-000000000001','dd14dec8-b7a6-5069-80f6-fe732e79607f','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('e06c3233-ec8a-5675-ad4e-c57ff40b6e5d','71000000-0000-4000-8000-000000000030','dd14dec8-b7a6-5069-80f6-fe732e79607f','734f7e2d-7d1f-548c-91a5-c5896baabd66','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('a0f0ea2f-5b4b-59de-8a47-45273fb3f323','71000000-0000-4000-8000-000000000029','73000000-0000-4000-8000-000000000001','78631eab-bef0-55bd-abef-17a05537c386','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('05528ce2-6dc9-5d07-9939-4bf6167fd0bb','71000000-0000-4000-8000-000000000030','78631eab-bef0-55bd-abef-17a05537c386','9bdfda47-bbc0-5f78-861e-747b19ced26a','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('b160be68-970e-58b4-b7b8-41c611ce3cf0','71000000-0000-4000-8000-000000000029','73000000-0000-4000-8000-000000000001','19f5e7bf-34c9-51ef-b50f-ef5c337defc3','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('28f2e024-00a0-574e-8c79-476fbf5941a0','71000000-0000-4000-8000-000000000030','19f5e7bf-34c9-51ef-b50f-ef5c337defc3','3b713d9e-21f0-5728-9632-f630253cad98','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('e3ec9088-39ad-59b1-a971-171a57d98f08','71000000-0000-4000-8000-000000000053','f1fa1826-8521-58cb-ba9d-60658e672a25','0e360076-1a6d-5347-b956-9eeca5a8663a','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('36a9d307-14d6-5140-94b5-ccf07c86e35a','71000000-0000-4000-8000-000000000054','0e360076-1a6d-5347-b956-9eeca5a8663a','d355c874-dba2-50b0-ae74-989c8c1a92b8','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
--> statement-breakpoint
INSERT INTO graph_edges ("id","typeId","fromId","toId","title","body","properties","archived","revision","createdBy","updatedBy","createdAt","updatedAt") VALUES ('4b1ff47b-c0cf-5ccd-a050-1cc70145db37','71000000-0000-4000-8000-000000000055','d355c874-dba2-50b0-ae74-989c8c1a92b8','48f84fdf-2b2c-586d-87f1-ca0abd4cb63b','','','{}',0,1,'seed:entities-v1','seed:entities-v1',1792886400000,1792886400000);
