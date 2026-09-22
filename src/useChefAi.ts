import { useCallback, useRef, useState } from "react";
import * as api from "./api";
import { getAiConfig, setAiConfig } from "./storage";
import type { AiConfig, GeneratedCommit, GeneratedPr } from "./types";
import { useRepo } from "./repoContext";

export function useChefAi() {
  const { repoPath, notify } = useRepo();
  const [config, setConfigState] = useState<AiConfig>(getAiConfig);
  const [loading, setLoading] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => Promise<void>) | null>(null);
  const cancelIdRef = useRef(0);

  const updateConfig = useCallback((next: AiConfig) => {
    setAiConfig(next);
    setConfigState(next);
  }, []);

  const cancel = useCallback(() => {
    cancelIdRef.current += 1;
    setLoading(false);
    api.aiCancelGeneration().catch(() => {});
  }, []);

  const checkEmbeddedReady = useCallback(async (): Promise<boolean> => {
    const cfg = getAiConfig();
    if (cfg.provider === "embedded") {
      try {
        const st = await api.aiGetEmbeddedStatus();
        if (!st.installed) {
          setShowDownloadModal(true);
          return false;
        }
      } catch {
        setShowDownloadModal(true);
        return false;
      }
    }
    return true;
  }, []);

  const generateCommit = useCallback(
    async (stagedOnly = true, currentMessage?: string | null): Promise<GeneratedCommit | null> => {
      const cfg = getAiConfig();
      if (cfg.provider === "embedded") {
        const ready = await checkEmbeddedReady();
        if (!ready) {
          setPendingAction(() => async () => {
            await generateCommit(stagedOnly, currentMessage);
          });
          return null;
        }
      }
      const reqId = ++cancelIdRef.current;
      setLoading(true);
      try {
        const result = await api.aiGenerateCommit(repoPath, stagedOnly, cfg, currentMessage);
        if (reqId !== cancelIdRef.current) return null;
        return result;
      } catch (err) {
        if (reqId !== cancelIdRef.current) return null;
        const msg = String(err);
        if (msg.includes("cancelled")) {
          return null;
        }
        if (msg.includes("Chef AI model is not installed")) {
          setShowDownloadModal(true);
          return null;
        }
        if (msg.includes("Cannot connect") || msg.includes("Could not connect")) {
          notify(
            `Chef AI: Cannot connect to ${cfg.endpoint}. Make sure ${
              cfg.provider === "ollama" ? "'ollama serve'" : "your local AI server"
            } is running (or configure in Settings > Chef AI).`,
            true
          );
        } else {
          notify(`Chef AI: ${msg}`, true);
        }
        return null;
      } finally {
        if (reqId === cancelIdRef.current) {
          setLoading(false);
        }
      }
    },
    [repoPath, notify, checkEmbeddedReady]
  );

  const generatePr = useCallback(
    async (base: string, head: string): Promise<GeneratedPr | null> => {
      const cfg = getAiConfig();
      if (cfg.provider === "embedded") {
        const ready = await checkEmbeddedReady();
        if (!ready) {
          return null;
        }
      }
      const reqId = ++cancelIdRef.current;
      setLoading(true);
      try {
        const result = await api.aiGeneratePr(repoPath, base, head, cfg);
        if (reqId !== cancelIdRef.current) return null;
        return result;
      } catch (err) {
        if (reqId !== cancelIdRef.current) return null;
        const msg = String(err);
        if (msg.includes("cancelled")) {
          return null;
        }
        if (msg.includes("Chef AI model is not installed")) {
          setShowDownloadModal(true);
          return null;
        }
        notify(`Chef AI: ${msg}`, true);
        return null;
      } finally {
        if (reqId === cancelIdRef.current) {
          setLoading(false);
        }
      }
    },
    [repoPath, notify, checkEmbeddedReady]
  );

  const explainConflict = useCallback(
    async (path: string, ours: string, theirs: string): Promise<string | null> => {
      const cfg = getAiConfig();
      if (cfg.provider === "embedded") {
        const ready = await checkEmbeddedReady();
        if (!ready) {
          return null;
        }
      }
      const reqId = ++cancelIdRef.current;
      setLoading(true);
      try {
        const result = await api.aiExplainConflict(repoPath, path, ours, theirs, cfg);
        if (reqId !== cancelIdRef.current) return null;
        return result;
      } catch (err) {
        if (reqId !== cancelIdRef.current) return null;
        const msg = String(err);
        if (msg.includes("cancelled")) {
          return null;
        }
        if (msg.includes("Chef AI model is not installed")) {
          setShowDownloadModal(true);
          return null;
        }
        notify(`Chef AI: ${msg}`, true);
        return null;
      } finally {
        if (reqId === cancelIdRef.current) {
          setLoading(false);
        }
      }
    },
    [repoPath, notify, checkEmbeddedReady]
  );

  const handleDownloadSuccess = useCallback(() => {
    setShowDownloadModal(false);
    if (pendingAction) {
      pendingAction();
      setPendingAction(null);
    }
  }, [pendingAction]);

  return {
    config,
    updateConfig,
    loading,
    generateCommit,
    generatePr,
    explainConflict,
    cancel,
    showDownloadModal,
    setShowDownloadModal,
    handleDownloadSuccess,
  };
}
