import { api } from "./api";
import type { RuntimeInfo } from "./types";
import { useAppStore } from "../stores/app-store";

let refreshSequence = 0;

export async function refreshGlobalState(currentRuntime?: RuntimeInfo) {
  const sequence = ++refreshSequence;
  const nextRuntimePromise = currentRuntime ? Promise.resolve(currentRuntime) : api.runtime();
  const previous = useAppStore.getState();
  const [
    workspacesResult,
    installationsResult,
    catalogResult,
    globalMemoriesResult,
    activityResult,
    scanRootsResult,
    excludedResult,
    runtimeResult,
    remoteGatewaysResult,
  ] = await Promise.allSettled([
    api.workspaces(),
    api.agentInstallations(),
    api.catalogAssets(),
    api.globalMemories(),
    api.activity(),
    api.scanRoots(),
    api.excludedWorkspaces(),
    nextRuntimePromise,
    api.remoteGateways(),
  ]);
  const valueOr = <T>(result: PromiseSettledResult<T>, fallback: T): T =>
    result.status === "fulfilled" ? result.value : fallback;
  const workspaces = valueOr(workspacesResult, previous.workspaces);
  const installations = valueOr(installationsResult, previous.installations);
  const catalog = valueOr(catalogResult, previous.catalog);
  const globalMemories = valueOr(globalMemoriesResult, previous.globalMemories);
  const activity = valueOr(activityResult, previous.activity);
  const scanRoots = valueOr(scanRootsResult, previous.scanRoots);
  const excluded = valueOr(excludedResult, previous.excluded);
  const runtime = valueOr(runtimeResult, currentRuntime ?? previous.runtime);
  const remoteGateways = valueOr(remoteGatewaysResult, previous.remoteGateways);

  let doctorSummaries = {};
  try {
    const summaries = await api.workspaceDoctorSummaries(
      workspaces.map((workspace) => workspace.id),
    );
    doctorSummaries = Object.fromEntries(
      summaries.map((summary) => [summary.workspace_id, summary]),
    );
  } catch {
    /* 首次迁移或后台扫描尚未完成时显示空状态。 */
  }

  let insightsSummary = useAppStore.getState().insightsSummary;
  let insightsStatus = useAppStore.getState().insightsStatus;
  try {
    [insightsSummary, insightsStatus] = await Promise.all([
      api.insightsSummary(),
      api.insightsStatus(),
    ]);
  } catch {
    /* 首次迁移或后台采集尚未完成时显示空状态。 */
  }

  let quotaStatus = useAppStore.getState().quotaStatus;
  try {
    quotaStatus = await api.quotaCollectorStatus();
  } catch {
    /* Sidecar 尚未准备时由诊断页展示不可用状态。 */
  }

  const state = {
    workspaces,
    workspacesLoaded: true,
    installations,
    catalog,
    globalMemories,
    activity,
    scanRoots,
    excluded,
    runtime,
    remoteGateways,
    doctorSummaries,
    insightsSummary,
    insightsStatus,
    quotaStatus,
  };
  if (sequence === refreshSequence) useAppStore.setState(state);
  return state;
}
