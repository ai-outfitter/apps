import { prepareAppTests } from "@ai-outfitter/app-test/prepare";
// Wiki journeys run against the Onto app in this repository.
prepareAppTests(new URL("../../onto", import.meta.url));
prepareAppTests(new URL("..", import.meta.url));
