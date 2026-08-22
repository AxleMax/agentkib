import { useState } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { createAppRouter } from "../router";
import { useAppStore } from "../stores/app-store";
import { useWorkspaceStore } from "../stores/workspace-store";

export function App() {
  const [appRouter] = useState(() => {
    if (import.meta.env.MODE === "test") {
      useAppStore.getState().reset();
      useWorkspaceStore.getState().resetWorkspace();
      window.location.hash = "";
    }

    return createAppRouter();
  });

  return <RouterProvider router={appRouter} />;
}
