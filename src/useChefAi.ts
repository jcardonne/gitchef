import { useCallback, useState } from "react";
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

  const updateConfig = useCallback((next: AiConfig) => {
    setAiConfig(next);
    setConfigState(next);
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
    async (stagedOnly = true): Promise<GeneratedCommit | null> => {
      const cfg = getAiConfig();
      if (cfg.provider === "embedded") {
        const ready = await checkEmbeddedReady();
        if (!ready) {
          setPendingAction(() => async () => {
            await generateCommit(stagedOnly);
          });
          return null;
        }
      }
      setLoading(true);
      try {
        const result = await api.aiGenerateCommit(repoPath, stagedOnly, cfg);
        return result;
      } catch (err) {
        const msg = String(err);
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
        setLoading(false);
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
      setLoading(true);
      try {
        const result = await api.aiGeneratePr(repoPath, base, head, cfg);
        return result;
      } catch (err) {
        const msg = String(err);
        if (msg.includes("Chef AI model is not installed")) {
          setShowDownloadModal(true);
          return null;
        }
        notify(`Chef AI: ${msg}`, true);
        return null;
      } finally {
        setLoading(false);
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
      setLoading(true);
      try {
        const result = await api.aiExplainConflict(repoPath, path, ours, theirs, cfg);
        return result;
      } catch (err) {
        const msg = String(err);
        if (msg.includes("Chef AI model is not installed")) {
          setShowDownloadModal(true);
          return null;
        }
        notify(`Chef AI: ${msg}`, true);
        return null;
      } finally {
        setLoading(false);
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
    showDownloadModal,
    setShowDownloadModal,
    handleDownloadSuccess,
  };
}
