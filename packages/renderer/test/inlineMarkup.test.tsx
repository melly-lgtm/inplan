// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderInline } from "../src/inlineMarkup";

afterEach(cleanup);

const mount = (text: string) => render(<div data-testid="x">{renderInline(text)}</div>).getByTestId("x");

describe("renderInline (light agent-message markup)", () => {
  it("renders **bold** as a toned-down span (not a literal asterisk), keeping the inner text", () => {
    const el = mount("**What I did**");
    const strong = el.querySelector(".ap-md-strong");
    expect(strong?.textContent).toBe("What I did");
    expect(el.textContent).toBe("What I did"); // the `**` markers are gone
  });

  it("renders `code` as a code element", () => {
    const el = mount("run `npm test` now");
    expect(el.querySelector("code.ap-md-code")?.textContent).toBe("npm test");
    expect(el.textContent).toBe("run npm test now");
  });

  it("leaves plain text (and lone asterisks) untouched", () => {
    const el = mount("a * b and 2 * 3 = 6");
    expect(el.querySelector(".ap-md-strong")).toBeNull();
    expect(el.textContent).toBe("a * b and 2 * 3 = 6");
  });

  it("handles multiple spans and bold spanning across a newline", () => {
    const el = mount("**a**\nmid `c` **d**");
    expect(el.querySelectorAll(".ap-md-strong").length).toBe(2);
    expect(el.querySelectorAll("code.ap-md-code").length).toBe(1);
    expect(el.textContent).toBe("a\nmid c d");
  });
});
