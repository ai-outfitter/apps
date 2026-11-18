import { prepareAppTests } from "@ai-outfitter/app-test/prepare";
// Cross-app journeys run against these built operational packages in a clean checkout.
prepareAppTests(new URL("../../onto", import.meta.url));
prepareAppTests(new URL("../../planning", import.meta.url));
prepareAppTests(new URL("..", import.meta.url));
