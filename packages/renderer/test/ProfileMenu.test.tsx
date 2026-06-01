// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileMenu } from "../src/ProfileMenu";

afterEach(cleanup);

const user = { name: "Diane Jung", email: "diane@example.com" };

describe("ProfileMenu", () => {
  it("shows initials for a signed-in user and opens to name + email", () => {
    render(<ProfileMenu user={user} agentLocation={null} actions={[]} />);
    const avatar = screen.getByRole("button", { name: /account menu/i });
    expect(avatar.textContent).toContain("DJ");
    fireEvent.click(avatar);
    expect(document.body.textContent).toContain("Diane Jung");
    expect(document.body.textContent).toContain("diane@example.com");
  });

  it("shows a signed-out affordance when there is no user", () => {
    render(<ProfileMenu user={null} agentLocation={null} actions={[{ label: "Sign in", onSelect: () => {} }]} />);
    const avatar = screen.getByRole("button", { name: /not signed in/i });
    expect(avatar.textContent).toContain("?");
    fireEvent.click(avatar);
    expect(document.body.textContent).toContain("Not signed in");
    expect(screen.getByRole("menuitem", { name: "Sign in" })).toBeTruthy();
  });

  it("renders the agent-location badge", () => {
    const { rerender } = render(<ProfileMenu user={user} agentLocation="local" actions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(document.body.textContent).toContain("Agent · your machine");

    rerender(<ProfileMenu user={user} agentLocation="cloud" actions={[]} />);
    expect(document.body.textContent).toContain("Agent · cloud");

    rerender(<ProfileMenu user={user} agentLocation={null} actions={[]} />);
    expect(document.body.textContent).toContain("No agent attached");
  });

  it("invokes a host action and closes the menu", () => {
    const onSelect = vi.fn();
    render(<ProfileMenu user={user} agentLocation="local" actions={[{ label: "Collaborate on Cloud", onSelect, primary: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Collaborate on Cloud" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    // menu closed → the action is gone from the DOM
    expect(screen.queryByRole("menuitem", { name: "Collaborate on Cloud" })).toBeNull();
  });

  it("does not invoke a disabled action", () => {
    const onSelect = vi.fn();
    render(<ProfileMenu user={user} agentLocation={null} actions={[{ label: "Save locally", onSelect, disabled: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save locally" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes on an outside click", () => {
    render(<ProfileMenu user={user} agentLocation={null} actions={[{ label: "Sign out", onSelect: () => {}, danger: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
  });
});
