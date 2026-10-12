import { useState } from "react";
import { btn } from "./ui";

export function ApiKeySetup({ onSave }: { onSave: (key: string) => void }) {
  const [value, setValue] = useState("");
  const valid = value.trim().startsWith("sk-ant-");

  return (
    <div style={{ maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>填入你的 Anthropic API key</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        Agent 在这个扩展里运行，直接调用 Anthropic API。你的 key 存在本机的{" "}
        <code>chrome.storage.local</code> 里，不会发往其他任何地方。
      </p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="sk-ant-..."
        style={{
          width: "100%",
          padding: 12,
          fontSize: 14,
          borderRadius: 4,
          border: "1px solid #ddd",
          fontFamily: "ui-monospace, monospace",
        }}
      />
      <button
        style={{ ...btn, marginTop: 16, opacity: valid ? 1 : 0.5 }}
        disabled={!valid}
        onClick={() => onSave(value.trim())}
      >
        保存
      </button>
    </div>
  );
}
