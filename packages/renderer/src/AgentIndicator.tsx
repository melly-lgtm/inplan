// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import type { AgentLocation, AgentPolicy } from "./api";
import { useT } from "./i18n";

/** Quota gauge: a solid green core (the "connected" indicator) with only the outer ring
 *  pie-charted for usage — `color` fills `pct` of the ring, the rest is `var(--line)`.
 *  `pct` ∈ [0..1]. The green centre stays green regardless of usage; the ring tint comes
 *  from `color` (light green → amber → red as usage climbs; dark blue for a BYO key). */
function QuotaPie({ pct, color }: { pct: number; color: string }): JSX.Element {
  const deg = Math.round(Math.max(0, Math.min(1, pct)) * 360);
  return (
    // The conic ring carries usage (`color` fills `pct`, `var(--line)` the rest); the inner
    // core disc is the green "connected" indicator and stays green regardless of usage.
    <span className="ap-agent-pie" style={{ background: `conic-gradient(${color} ${deg}deg, var(--line) 0)` }} aria-hidden="true">
      <span className="ap-agent-pie-core" aria-hidden="true" />
    </span>
  );
}

/**
 * Menu-bar agent connection indicator (the cloud/quota indicator, moved out of the
 * profile menu). Shows where the agent runs + its model, a quota pie when a managed
 * agent is metered (light green → amber → red by usage; dark blue for BYO key), a green dot for
 * a local agent and a red dot when none is connected. Clicking opens the connection
 * preference picker. Purely presentational — the host supplies the state.
 */
export function AgentIndicator({
  location,
  model,
  quota,
  byoKey,
  policy,
  onSetPolicy,
  localCommand,
}: {
  location: AgentLocation | null;
  model?: string;
  quota?: { usedPct: number; overage: boolean };
  byoKey?: boolean;
  policy?: AgentPolicy;
  onSetPolicy?: (p: AgentPolicy) => void | Promise<void>;
  /** Host-supplied command a local agent runs to serve this doc (cloud); shown under "local". */
  localCommand?: string;
}): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // What the human pastes to their coding agent: an instruction (with the connect command inlined),
  // not a command for the human to run themselves. Copy carries the FULL text; the box shows a
  // middle-elided preview (the full bootstrap — check/install/login/connect — is long).
  const agentMessage = localCommand ? t("agent.localCmdBody", { cmd: localCommand }) : "";
  const preview = agentMessage.length > 84 ? `${agentMessage.slice(0, 52)} … ${agentMessage.slice(-26)}` : agentMessage;
  const copy = (): void => {
    if (!agentMessage) return;
    // `navigator.clipboard?.writeText(...)` is undefined when the Clipboard API is unavailable;
    // `.then` would throw on it (?. guards only the call, not the chained .then). Guard the result.
    const write = navigator.clipboard?.writeText(agentMessage);
    if (!write) return;
    void write.then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  const POLICY_OPTIONS: { value: AgentPolicy; label: string }[] = [
    { value: "auto", label: t("agent.connectCloud") },
    { value: "local", label: t("agent.waitLocal") },
    { value: "manual", label: t("agent.dontConnect") },
  ];
  // The label next to the icon: `remote (model)` / `local (model)` / `disconnected`.
  const labelFor = (loc: AgentLocation | null, m?: string): string => {
    if (loc === "cloud") return `${t("agent.remote")}${m ? ` (${m})` : ""}`;
    if (loc === "local") return `${t("agent.local")}${m ? ` (${m})` : ""}`;
    return t("agent.disconnected");
  };
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  let icon: JSX.Element;
  if (location === "cloud") {
    // Usage-ring tint: light green < 75%, amber 75–95%, red at/over 95% (or overage). BYO keys are
    // unmetered → dark blue; no quota (uncapped plan) → the plain green accent.
    const color = byoKey
      ? "var(--agent-byo, #1e3a8a)"
      : quota
        ? quota.overage || quota.usedPct >= 0.95
          ? "#c0392b" // red (matches .ap-agent-quota-at)
          : quota.usedPct >= 0.75
            ? "#e0a23b" // amber/yellow
            : "#3fa46a" // light green
        : "var(--accent)";
    icon = quota ? <QuotaPie pct={quota.usedPct} color={color} /> : <span className="ap-agent-dot" style={{ background: color }} aria-hidden="true" />;
  } else if (location === "local") {
    icon = <span className="ap-agent-dot ap-agent-local" aria-hidden="true" />;
  } else {
    icon = <span className="ap-agent-dot ap-agent-off" aria-hidden="true" />;
  }

  const label = labelFor(location, model);
  const quotaText = quota ? ` · ${Math.round(quota.usedPct * 100)}%${quota.overage ? ` ${t("agent.over")}` : ""}` : "";
  // Capped plans (no overage) warn as they approach the cap and report when turns are paused. The
  // hard limit itself is enforced server-side — this is just the heads-up in the indicator.
  const quotaWarn: "at" | "near" | null = quota && !quota.overage ? (quota.usedPct >= 1 ? "at" : quota.usedPct >= 0.8 ? "near" : null) : null;
  return (
    <div className="ap-agent" ref={ref}>
      <button className="ap-agent-btn" title={`${t("agent.title", { label })}${quotaText}`} aria-label={t("agent.connectionLabel", { label })} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {icon}
        <span className="ap-agent-label">{label}</span>
      </button>
      {open && (
        <div className="ap-agent-menu" role="menu">
          <div className="ap-agent-detail">
            {location
              ? `${t("agent.detail", { where: location === "cloud" ? t("agent.whereCloud") : t("agent.whereLocal") })}${model ? ` · ${model}` : ""}`
              : t("agent.none")}
            {quota && (
              <div className="ap-agent-quota">{`${t("agent.plan", { pct: Math.round(quota.usedPct * 100) })}${quota.overage ? ` ${t("agent.overIncluded")}` : ""}`}</div>
            )}
            {quotaWarn && (
              <div className={`ap-agent-quota-warn ap-agent-quota-${quotaWarn}`} role="status">
                {t(quotaWarn === "at" ? "agent.atLimit" : "agent.nearLimit")}
              </div>
            )}
          </div>
          {policy && onSetPolicy && (
            <div className="ap-agent-policy" role="radiogroup" aria-label={t("agent.connection")}>
              {POLICY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  role="menuitemradio"
                  aria-checked={policy === o.value}
                  className={`ap-agent-policy-opt${policy === o.value ? " active" : ""}`}
                  onClick={() => void onSetPolicy(o.value)}
                >
                  <span className="ap-policy-dot" aria-hidden="true" />
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {/* "Wait for my local agent" → an instruction the human pastes to their coding agent so it
              connects to + serves this cloud doc (the connect command is inlined). */}
          {policy === "local" && agentMessage && (
            <div className="ap-agent-localcmd">
              <div className="ap-agent-localcmd-hint">{t("agent.localCmdHint")}</div>
              <div className="ap-agent-localcmd-row">
                <div className="ap-agent-localcmd-msg" title={agentMessage}>{preview}</div>
                <button className="ap-agent-localcmd-copy" onClick={copy} aria-label={t("agent.copy")}>
                  {copied ? t("agent.copied") : t("agent.copy")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
