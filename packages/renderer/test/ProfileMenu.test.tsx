// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ProfileMenu is now identity + host actions only — the agent connection badge +
// policy picker moved to the menu-bar <AgentIndicator> (see AgentIndicator.test).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileMenu } from "../src/ProfileMenu";

afterEach(cleanup);

const user = { name: "Diane Jung", email: "diane@example.com" };

describe("ProfileMenu", () => {
  it("shows initials for a signed-in user and opens to name + email", () => {
    render(<ProfileMenu user={user} actions={[]} />);
    const avatar = screen.getByRole("button", { name: /account menu/i });
    expect(avatar.textContent).toContain("DJ");
    fireEvent.click(avatar);
    expect(document.body.textContent).toContain("Diane Jung");
    expect(document.body.textContent).toContain("diane@example.com");
  });

  it("shows a signed-out affordance when there is no user", () => {
    render(<ProfileMenu user={null} actions={[{ label: "Sign in", onSelect: () => {} }]} />);
    const avatar = screen.getByRole("button", { name: /not signed in/i });
    expect(avatar.textContent).toContain("?");
    fireEvent.click(avatar);
    expect(document.body.textContent).toContain("Not signed in");
    expect(screen.getByRole("menuitem", { name: "Sign in" })).toBeTruthy();
  });

  it("renders nothing when there is no user and no actions (local-only / cloud unreachable)", () => {
    const { container } = render(<ProfileMenu user={null} actions={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("invokes a host action and closes the menu", () => {
    const onSelect = vi.fn();
    render(<ProfileMenu user={user} actions={[{ label: "Collaborate on Cloud", onSelect, primary: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Collaborate on Cloud" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Collaborate on Cloud" })).toBeNull(); // menu closed
  });

  it("does not invoke a disabled action", () => {
    const onSelect = vi.fn();
    render(<ProfileMenu user={user} actions={[{ label: "Save locally", onSelect, disabled: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save locally" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows a language picker in the menu when the host offers more than one locale", () => {
    const setLocale = vi.fn();
    // get() must return a STABLE snapshot (the I18nController contract — useSyncExternalStore).
    const i18nState = { locale: "en", catalogs: { en: {} }, available: [{ code: "en", label: "English" }, { code: "ja", label: "日本語" }], setLocale };
    (window as unknown as { api: unknown }).api = {
      i18n: { get: () => i18nState, subscribe: () => () => {} },
    };
    try {
      render(<ProfileMenu user={user} actions={[]} />);
      fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
      const sel = screen.getByRole("combobox", { name: /language/i });
      fireEvent.change(sel, { target: { value: "ja" } });
      expect(setLocale).toHaveBeenCalledWith("ja");
    } finally {
      delete (window as unknown as { api?: unknown }).api;
    }
  });

  it("closes on an outside click", () => {
    render(<ProfileMenu user={user} actions={[{ label: "Sign out", onSelect: () => {}, danger: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
  });
});
