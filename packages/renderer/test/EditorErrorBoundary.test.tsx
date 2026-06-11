// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorErrorBoundary } from "../src/EditorErrorBoundary";

afterEach(cleanup);

function Boom({ throwNow }: { throwNow: boolean }): JSX.Element {
  if (throwNow) throw new Error("multiple instances of @codemirror/state");
  return <div>editor ok</div>;
}

describe("EditorErrorBoundary", () => {
  it("renders children when they don't throw", () => {
    render(
      <EditorErrorBoundary label="The source editor">
        <Boom throwNow={false} />
      </EditorErrorBoundary>,
    );
    expect(screen.getByText("editor ok")).toBeTruthy();
  });

  it("contains a child crash and shows the labelled message + error text", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <EditorErrorBoundary label="The source editor">
        <Boom throwNow={true} />
      </EditorErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(document.body.textContent).toContain("The source editor couldn't load");
    expect(document.body.textContent).toContain("multiple instances of @codemirror/state");
    // Recovery affordance is present.
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    spy.mockRestore();
  });

  it("retries (clears the error) when 'Try again' is clicked", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A child that throws on first render, then succeeds (its prop flips before the retry re-render).
    let shouldThrow = true;
    function Flaky(): JSX.Element {
      if (shouldThrow) throw new Error("boom");
      return <div>recovered</div>;
    }
    render(
      <EditorErrorBoundary>
        <Flaky />
      </EditorErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("recovered")).toBeTruthy();
    spy.mockRestore();
  });
});
