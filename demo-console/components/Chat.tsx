"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState } from "react";
import { Panel, Button, Label } from "./ui";

const MODELS = [
  { id: "demo-router", label: "Adaptive router", note: "picks per request" },
  { id: "claude-sonnet", label: "Claude Sonnet 4.5", note: "Anthropic" },
  { id: "claude-haiku", label: "Claude Haiku 4.5", note: "Anthropic" },
  { id: "nova-lite", label: "Nova Lite", note: "Amazon" },
  { id: "gpt-on-bedrock", label: "GPT OSS 120B", note: "OpenAI" },
  { id: "ipr-nova", label: "Nova prompt router", note: "Bedrock IPR" },
];

export function Chat() {
  const [model, setModel] = useState("demo-router");
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const busy = status === "submitted" || status === "streaming";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    // The model travels per message, so switching the picker mid-conversation
    // changes who answers next rather than restarting the thread.
    sendMessage({ text }, { body: { model } });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Label>Answering</Label>
        <div className="flex flex-wrap gap-1.5">
          {MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setModel(m.id)}
              className={`rounded-sm border px-3 py-1.5 text-[13px] font-semibold transition-colors ${
                model === m.id
                  ? "border-navy bg-navy text-canvas"
                  : "border-rule bg-transparent text-muted-ink hover:text-navy"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <Panel className="flex min-h-[340px] flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {messages.length === 0 && (
            <p className="max-w-[54ch] text-[15px] text-muted-ink">
              One endpoint, every model. Ask something, then switch who answers with the
              buttons above — the request shape never changes.
            </p>
          )}
          {messages.map((m) => {
            const text = m.parts
              .filter((p) => p.type === "text")
              .map((p) => ("text" in p ? p.text : ""))
              .join("");
            return (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                <div
                  className={`max-w-[62ch] whitespace-pre-wrap rounded-sm px-4 py-3 text-[15px] leading-relaxed ${
                    m.role === "user"
                      ? "bg-navy text-canvas"
                      : "border border-rule bg-warm-gray text-navy"
                  }`}
                >
                  {text || (busy ? "…" : "")}
                </div>
              </div>
            );
          })}
          {error && (
            <p className="border-l-2 border-brand-red pl-3 text-[14px] text-brand-red">
              {error.message}
            </p>
          )}
        </div>

        <form onSubmit={submit} className="flex gap-2 border-t border-rule p-3">
          <input
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            // Explicit, rather than relying on the form's implicit submit.
            // Enter has to work on stage; a speaker who has to reach for the
            // mouse mid-sentence has lost the room.
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(e as unknown as React.FormEvent);
              }
            }}
            autoFocus
            placeholder="Ask anything…"
            className="min-w-0 flex-1 rounded-sm border border-rule bg-transparent px-3 py-2.5 text-[15px] text-navy outline-none placeholder:text-muted-ink focus-visible:border-navy"
          />
          <Button type="submit" disabled={busy || !input.trim()}>
            {busy ? "Answering…" : "Send"}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
