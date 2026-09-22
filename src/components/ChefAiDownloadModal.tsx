import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useEscape } from "../useEscape";
import * as api from "../api";
import type { DownloadProgressEvent, EmbeddedModelStatus } from "../types";

interface Props {
  onClose: () => void;
  onSuccess?: () => void;
}

export default function ChefAiDownloadModal({ onClose, onSuccess }: Props) {
  const [status, setStatus] = useState<EmbeddedModelStatus | null>(null);
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscape(onClose);

  const fetchStatus = async () => {
    try {
      const res = await api.aiGetEmbeddedStatus();
      setStatus(res);
      if (res.error) {
        setError(res.error);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    fetchStatus();

    let disposed = false;
    let unlisten: (() => void) | undefined;

    listen<DownloadProgressEvent>("chef://model-download-progress", (event) => {
      setProgress(event.payload);
      if (event.payload.error) {
        setError(event.payload.error);
      } else if (event.payload.done) {
        fetchStatus();
        setTimeout(() => {
          onSuccess?.();
          onClose();
        }, 600);
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleStartDownload = async () => {
    setIsStarting(true);
    setError(null);
    try {
      await api.aiDownloadEmbeddedModel();
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancel = async () => {
    try {
      await api.aiCancelEmbeddedDownload();
      setProgress(null);
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    }
  };

  const isDownloading = status?.downloading || (progress && !progress.done && !progress.error);
  const percent = progress
    ? Math.round(progress.progress_percent)
    : status?.progress_percent
    ? Math.round(status.progress_percent)
    : 0;

  const formatMb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  const formatSpeed = (bytesPerSec: number) => {
    if (bytesPerSec > 1024 * 1024) {
      return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    return `${Math.round(bytesPerSec / 1024)} KB/s`;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 480, maxWidth: "92vw", padding: 22 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "linear-gradient(135deg, var(--accent) 0%, #a855f7 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              boxShadow: "0 2px 8px rgba(168, 85, 247, 0.3)",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1.5l1.2 3.8 3.8 1.2-3.8 1.2L8 11.5 6.8 7.7 3 6.5l3.8-1.2L8 1.5z" />
              <path d="M12.5 10.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9z" />
            </svg>
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Chef AI — 1-Click Local Assistant</h3>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              Ultra-lightweight embedded model • 100% private
            </div>
          </div>
        </div>

        <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)", margin: "14px 0" }}>
          Chef AI generates conventional commits, drafts PRs, and explains merge conflicts with zero external tools or dependencies.
        </div>

        <div
          style={{
            background: "var(--bg-elev2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "12px 14px",
            fontSize: 12,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--muted)" }}>Model</span>
            <span style={{ fontWeight: 600 }}>Qwen 2.5 Coder 0.5B Instruct</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--muted)" }}>Download size</span>
            <span>~468 MB (GGUF Q4_K_M)</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--muted)" }}>Memory footprint</span>
            <span>&lt; 450 MB RAM (fast on any machine)</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--muted)" }}>Privacy</span>
            <span style={{ color: "var(--green, #22c55e)", fontWeight: 600 }}>100% Offline / Zero cloud</span>
          </div>
        </div>

        {error && (
          <div
            style={{
              background: "rgba(239, 68, 68, 0.1)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              color: "#ef4444",
              borderRadius: 6,
              padding: "8px 12px",
              fontSize: 12,
              marginBottom: 14,
            }}
          >
            {error}
          </div>
        )}

        {isDownloading ? (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
              <span style={{ fontWeight: 600 }}>Downloading model...</span>
              <span style={{ color: "var(--accent)" }}>{percent}%</span>
            </div>
            <div
              style={{
                width: "100%",
                height: 8,
                background: "var(--bg-elev2)",
                borderRadius: 4,
                overflow: "hidden",
                border: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${percent}%`,
                  background: "linear-gradient(90deg, var(--accent) 0%, #a855f7 100%)",
                  transition: "width 0.2s ease",
                }}
              />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "var(--muted)",
                marginTop: 6,
              }}
            >
              <span>
                {progress
                  ? `${formatMb(progress.bytes_downloaded)} MB / ${formatMb(progress.total_bytes)} MB`
                  : "Preparing..."}
              </span>
              <span>{progress && progress.speed_bytes_per_sec > 0 ? formatSpeed(progress.speed_bytes_per_sec) : ""}</span>
            </div>
          </div>
        ) : null}

        <div className="modal-actions" style={{ marginTop: 18 }}>
          {isDownloading ? (
            <button type="button" onClick={handleCancel}>
              Cancel
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose}>
                Maybe Later
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={isStarting}
                onClick={handleStartDownload}
                style={{
                  background: "linear-gradient(135deg, var(--accent) 0%, #a855f7 100%)",
                  borderColor: "transparent",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  boxShadow: "0 2px 10px rgba(168, 85, 247, 0.35)",
                }}
              >
                {isStarting ? (
                  <>
                    <svg className="spinner" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <circle cx="8" cy="8" r="6" strokeOpacity={0.3} />
                      <path d="M8 2a6 6 0 0 1 6 6" />
                    </svg>
                    <span>Starting...</span>
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 2v9M4.5 7.5L8 11l3.5-3.5M2.5 13.5h11" />
                    </svg>
                    <span>Download &amp; Enable (1-Click)</span>
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
