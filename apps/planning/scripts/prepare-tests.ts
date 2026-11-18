import { prepareAppTests } from "@ai-outfitter/app-test/prepare";
// Cross-app journeys run against the Onto (Wiki) and Software Foundry apps in this repository.
prepareAppTests(new URL("../../onto", import.meta.url));
prepareAppTests(new URL("../../wiki", import.meta.url));
prepareAppTests(new URL("../../software-foundry", import.meta.url));
prepareAppTests(new URL("..", import.meta.url));
