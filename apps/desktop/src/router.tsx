import { createHashHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function createAppRouter() {
  return createRouter({
    routeTree,
    history: createHashHistory(),
    // TanStack still installs its render hook when this is `false`; returning
    // false from the callback also prevents the default window.scrollTo call.
    scrollRestoration: () => false,
  });
}

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
