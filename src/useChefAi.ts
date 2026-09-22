import { useCallback, useState } from "react";
import * as api from "./api";
import { getAiConfig, setAiConfig } from "./storage";
import type { AiConfig, GeneratedCommit, GeneratedPr } from "./types";
import { useRepo } from "./repoContext";

export function useChefAi() {
  const { repoPath, notify } = useRepo();
  const [config, setConfigState] = useState<AiConfig>(getAiConfig);
  const [loading, setLoading] = useState(false);

  const updateConfig = useCallback((next: AiConfig) => {
    setAiConfig(next);
    setConfigState(next);
  }, []);

  const generateCommit = useCallback(
    async (stagedOnly = true): Promise<GeneratedCommit | null> => {
      const cfg = getAiConfig();
      setLoading(true);
      try {
        const result = await api.aiGenerateCommit(repoPath, stagedOnly, cfg);
        return result;
      } catch (err) {
        const msg = String(err);
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
    [repoPath, notify]
  );

  const generatePr = useCallback(
    async (base: string, head: string): Promise<GeneratedPr | null> => {
      const cfg = getAiConfig();
      setLoading(true);
      try {
        const result = await api.aiGeneratePr(repoPath, base, head, cfg);
        return result;
      } catch (err) {
        const msg = String(err);
        notify(`Chef AI: ${msg}`, true);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [repoPath, notify]
  );

  const explainConflict = useCallback(
    async (path: string, ours: string, theirs: string): Promise<string | null> => {
      const cfg = getAiConfig();
      setLoading(true);
      try {
        const result = await api.aiExplainConflict(repoPath, path, ours, theirs, cfg);
        return result;
      } catch (err) {
        const msg = String(err);
        notify(`Chef AI: ${msg}`, true);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [repoPath, notify]
  );

  return {
    config,
    updateConfig,
    loading,
    generateCommit,
    generatePr,
    explainConflict,
  };
}
