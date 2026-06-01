// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Question } from "@inplan/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionChips } from "../src/QuestionChips";

afterEach(cleanup);

const single: Question = { multiSelect: false, choices: [{ label: "Postgres", description: "jsonb" }, { label: "SQLite", description: "" }] };
const multi: Question = { multiSelect: true, choices: [{ label: "macOS", description: "" }, { label: "Linux", description: "" }] };

const answerBtn = () => screen.getByRole("button", { name: /answer/i }) as HTMLButtonElement;

describe("QuestionChips (FR4 choice answering)", () => {
  it("multiple-choice: posts the single picked label", () => {
    const onAnswer = vi.fn();
    render(<QuestionChips question={single} disabled={false} onAnswer={onAnswer} />);
    expect(answerBtn().disabled).toBe(true); // nothing chosen yet
    fireEvent.click(screen.getByRole("radio", { name: /Postgres/ }));
    fireEvent.click(answerBtn());
    expect(onAnswer).toHaveBeenCalledWith(["Postgres"], "");
  });

  it("multiple-choice is mutually exclusive (last pick wins)", () => {
    const onAnswer = vi.fn();
    render(<QuestionChips question={single} disabled={false} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("radio", { name: /Postgres/ }));
    fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
    fireEvent.click(answerBtn());
    expect(onAnswer).toHaveBeenCalledWith(["SQLite"], "");
  });

  it("multi-select: posts every checked label", () => {
    const onAnswer = vi.fn();
    render(<QuestionChips question={multi} disabled={false} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /macOS/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Linux/ }));
    fireEvent.click(answerBtn());
    expect(onAnswer).toHaveBeenCalledWith(["macOS", "Linux"], "");
  });

  it("'Other' free text answers with no selection", () => {
    const onAnswer = vi.fn();
    render(<QuestionChips question={single} disabled={false} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByPlaceholderText(/Other/), { target: { value: "  DuckDB  " } });
    fireEvent.click(answerBtn());
    expect(onAnswer).toHaveBeenCalledWith([], "DuckDB"); // trimmed
  });

  it("Answer is disabled while nothing is chosen, and everything is disabled when locked", () => {
    const { rerender } = render(<QuestionChips question={single} disabled={false} onAnswer={() => {}} />);
    expect(answerBtn().disabled).toBe(true);
    rerender(<QuestionChips question={single} disabled={true} onAnswer={() => {}} />);
    expect((screen.getByRole("radio", { name: /Postgres/ }) as HTMLInputElement).disabled).toBe(true);
  });
});
