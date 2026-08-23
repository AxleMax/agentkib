// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeI18n } from "../core/i18n";
import { Button } from "./ui/button";
import { AppDialogProvider, useAppDialogs } from "./AppDialogProvider";

function Harness() {
  const dialogs = useAppDialogs();
  return <div>
    <Button onClick={() => void dialogs.confirm("First request").then((accepted) => document.body.dataset.first = String(accepted))}>First confirm</Button>
    <Button onClick={() => void dialogs.confirm("Second request").then((accepted) => document.body.dataset.second = String(accepted))}>Second confirm</Button>
    <Button onClick={() => {
      void dialogs.confirm("First request").then((accepted) => document.body.dataset.first = String(accepted));
      void dialogs.confirm("Second request").then((accepted) => document.body.dataset.second = String(accepted));
    }}>Queue confirms</Button>
    <Button onClick={() => void dialogs.notify("Saved locally").then(() => document.body.dataset.notified = "true")}>Notify</Button>
    <Button onClick={() => void dialogs.requestSecrets(["API_KEY", "TOKEN"]).then((values) => document.body.dataset.secrets = values ? JSON.stringify(values) : "cancelled")}>Secrets</Button>
  </div>;
}

beforeEach(async () => {
  await initializeI18n("en-US");
  delete document.body.dataset.first;
  delete document.body.dataset.second;
  delete document.body.dataset.notified;
  delete document.body.dataset.secrets;
});

afterEach(cleanup);

describe("AppDialogProvider", () => {
  it("queues confirmations and resolves confirm and cancel independently", async () => {
    const user = userEvent.setup();
    render(<AppDialogProvider><Harness /></AppDialogProvider>);

    await user.click(screen.getByRole("button", { name: "Queue confirms" }));
    expect(screen.getByText("First request")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(document.body.dataset.first).toBe("true");
    expect(await screen.findByText("Second request")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.body.dataset.second).toBe("false");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("dismisses confirmations with Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(<AppDialogProvider><Harness /></AppDialogProvider>);
    const trigger = screen.getByRole("button", { name: "First confirm" });

    await user.click(trigger);
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(document.body.dataset.first).toBe("false");
    expect(trigger).toHaveFocus();
  });

  it("shows notifications without a cancel action", async () => {
    const user = userEvent.setup();
    render(<AppDialogProvider><Harness /></AppDialogProvider>);

    await user.click(screen.getByRole("button", { name: "Notify" }));
    expect(await screen.findByText("Saved locally")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(document.body.dataset.notified).toBe("true");
  });

  it("clears secret values after cancel before reopening", async () => {
    const user = userEvent.setup();
    render(<AppDialogProvider><Harness /></AppDialogProvider>);

    await user.click(screen.getByRole("button", { name: "Secrets" }));
    await user.type(screen.getByLabelText("API_KEY"), "secret-one");
    await user.type(screen.getByLabelText("TOKEN"), "secret-two");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.body.dataset.secrets).toBe("cancelled");

    await user.click(screen.getByRole("button", { name: "Secrets" }));
    expect(screen.getByLabelText("API_KEY")).toHaveValue("");
    expect(screen.getByLabelText("TOKEN")).toHaveValue("");
    await user.type(screen.getByLabelText("API_KEY"), "new-key");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(JSON.parse(document.body.dataset.secrets ?? "{}")).toEqual({ API_KEY: "new-key", TOKEN: "" });
  });
});
