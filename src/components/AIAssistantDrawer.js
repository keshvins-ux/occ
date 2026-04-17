import { useState, useRef, useEffect } from "react";
import Ic from "./Ic";
import { BRAND, COLORS, RADIUS, SHADOWS } from "../theme";
import { fetchJson } from "../utils";

const SUGGESTIONS = [
  "Who are my top 5 customers this month?",
  "Which invoices are 60+ days overdue?",
  "Which SOs are at risk of missing delivery this week?",
  "Which stock items are below reorder level?",
  "Show me product sales trends for curry powder",
  "What happened this week?",
];

export default function AIAssistantDrawer({ open, onClose }) {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content:
        "Hi! I'm your OCC AI assistant, powered by Seri Rasa. Ask me anything about your business — customers, orders, stock, AR, or trends.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function sendMsg(text) {
    if (!text.trim() || sending) return;
    const userMsg = { role: "user", content: text };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setSending(true);

    try {
      const resp = await fetchJson("/api/ai-assistant", {
        method: "POST",
        body: JSON.stringify({
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: resp.content || "I wasn't able to get an answer.",
          data: resp.data,
          source: resp.source,
        },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `Sorry, something went wrong: ${err.message}. Try again or rephrase your question.`,
          error: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(15, 23, 42, 0.4)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 480,
          background: COLORS.surface,
          boxShadow: SHADOWS.drawer,
          display: "flex",
          flexDirection: "column",
          animation: "occ-slide-in 0.25s ease",
        }}
      >
        <style>{`@keyframes occ-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>

        {/* Header */}
        <div
          style={{
            padding: "20px 24px",
            borderBottom: `1px solid ${COLORS.borderFaint}`,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: RADIUS.lg,
              background: BRAND.accentGradient,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: SHADOWS.glow,
            }}
          >
            <Ic name="sparkle" size={20} color="#fff" />
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: COLORS.text,
                letterSpacing: "-0.01em",
              }}
            >
              OCC AI Assistant
            </div>
            <div
              style={{
                fontSize: 11,
                color: COLORS.textFaint,
                marginTop: 2,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: COLORS.success,
                  boxShadow: `0 0 8px ${COLORS.success}`,
                }}
              />
              Powered by Seri Rasa · Read-only
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              borderRadius: RADIUS.md,
              background: COLORS.surfaceAlt,
              border: `1px solid ${COLORS.borderStrong}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <Ic name="x" size={14} color={COLORS.textMuted} />
          </button>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {messages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
          {sending && (
            <div style={{ display: "flex", gap: 10 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 9,
                  background: BRAND.accentGradient,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  marginTop: 2,
                }}
              >
                <Ic name="sparkle" size={13} color="#fff" />
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: COLORS.textMuted,
                  background: COLORS.surfaceAlt,
                  padding: "12px 16px",
                  borderRadius: "4px 14px 14px 14px",
                  border: `1px solid ${COLORS.borderFaint}`,
                  fontStyle: "italic",
                }}
              >
                Thinking…
              </div>
            </div>
          )}
        </div>

        {/* Suggestions (first message only) */}
        {messages.length === 1 && !sending && (
          <div style={{ padding: "0 24px 12px" }}>
            <div
              style={{
                fontSize: 11,
                color: COLORS.textFaint,
                fontWeight: 600,
                marginBottom: 8,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Try asking
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {SUGGESTIONS.slice(0, 4).map((s) => (
                <button
                  key={s}
                  onClick={() => sendMsg(s)}
                  style={{
                    textAlign: "left",
                    padding: "10px 14px",
                    fontSize: 12,
                    color: COLORS.textSecondary,
                    background: COLORS.surfaceAlt,
                    border: `1px solid ${COLORS.borderStrong}`,
                    borderRadius: RADIUS.md,
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = BRAND.accentGlow;
                    e.currentTarget.style.color = BRAND.accent;
                    e.currentTarget.style.borderColor = "rgba(79, 124, 247, 0.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = COLORS.surfaceAlt;
                    e.currentTarget.style.color = COLORS.textSecondary;
                    e.currentTarget.style.borderColor = COLORS.borderStrong;
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: `1px solid ${COLORS.borderFaint}`,
            background: COLORS.surface,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              background: COLORS.surfaceAlt,
              borderRadius: RADIUS.lg,
              border: `1px solid ${COLORS.borderStrong}`,
              padding: "4px 4px 4px 16px",
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMsg(input)}
              disabled={sending}
              placeholder="Ask anything about your business..."
              style={{
                flex: 1,
                padding: "10px 0",
                fontSize: 13,
                outline: "none",
                border: "none",
                background: "transparent",
                color: COLORS.text,
              }}
            />
            <button
              onClick={() => sendMsg(input)}
              disabled={!input.trim() || sending}
              style={{
                width: 36,
                height: 36,
                borderRadius: RADIUS.md,
                background: input.trim() && !sending ? BRAND.accentGradient : COLORS.textGhost,
                border: "none",
                cursor: input.trim() && !sending ? "pointer" : "not-allowed",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: input.trim() && !sending ? SHADOWS.button : "none",
              }}
            >
              <Ic name="send" size={14} color="#fff" />
            </button>
          </div>
          <div
            style={{ fontSize: 10, color: COLORS.textGhost, textAlign: "center", marginTop: 8 }}
          >
            Claude can make mistakes. Verify important information.
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message: m }) {
  if (m.role === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div
          style={{
            fontSize: 13,
            color: "#fff",
            background: BRAND.accentGradient,
            padding: "10px 14px",
            borderRadius: "14px 4px 14px 14px",
            maxWidth: "80%",
            boxShadow: SHADOWS.button,
          }}
        >
          {m.content}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 10 }}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 9,
          background: BRAND.accentGradient,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        <Ic name="sparkle" size={13} color="#fff" />
      </div>
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: 13,
            color: m.error ? COLORS.danger : COLORS.text,
            lineHeight: 1.6,
            background: m.error ? COLORS.dangerBg : COLORS.surfaceAlt,
            padding: "12px 16px",
            borderRadius: "4px 14px 14px 14px",
            border: `1px solid ${m.error ? COLORS.dangerBg : COLORS.borderFaint}`,
            whiteSpace: "pre-wrap",
          }}
        >
          {m.content}
        </div>
        {m.data && Array.isArray(m.data.items) && (
          <div
            style={{
              marginTop: 10,
              background: COLORS.surface,
              borderRadius: RADIUS.lg,
              border: `1px solid ${COLORS.borderStrong}`,
              overflow: "hidden",
            }}
          >
            {m.data.items.map((it, j) => (
              <div
                key={j}
                style={{
                  padding: "12px 14px",
                  borderBottom:
                    j < m.data.items.length - 1 ? `1px solid ${COLORS.borderGhost}` : "none",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 10,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.text, marginBottom: 2 }}
                  >
                    {it.name}
                  </div>
                  {it.meta && (
                    <div style={{ fontSize: 11, color: COLORS.textFaint }}>{it.meta}</div>
                  )}
                </div>
                {it.value && (
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: COLORS.text,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {it.value}
                  </div>
                )}
              </div>
            ))}
            {Array.isArray(m.data.actions) && m.data.actions.length > 0 && (
              <div
                style={{
                  padding: "10px 14px",
                  background: COLORS.surfaceMuted,
                  borderTop: `1px solid ${COLORS.borderFaint}`,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                {m.data.actions.map((a, k) => (
                  <button
                    key={k}
                    onClick={() => a.href && (window.location.href = a.href)}
                    style={{
                      padding: "6px 12px",
                      fontSize: 11,
                      fontWeight: 600,
                      color: BRAND.accent,
                      background: BRAND.accentGlow,
                      border: "none",
                      borderRadius: RADIUS.sm,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    {a.label}
                    <Ic name="arrow" size={10} color={BRAND.accent} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {m.source && (
          <div
            style={{
              fontSize: 10,
              color: COLORS.textGhost,
              marginTop: 8,
              fontStyle: "italic",
            }}
          >
            Source: {m.source}
          </div>
        )}
      </div>
    </div>
  );
}
