// Preload bridge. This is the ONLY path between the renderer and Node/Electron.
// Spec §5/§6: renderer communicates through typed IPC only. Never expose
// Node.js, tokens, authorization codes or raw database access to the renderer.
//
// Both the robot and workbench windows load this same preload. It exposes a
// single typed `window.daymate` API; the renderer never touches ipcRenderer.

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/constants'
import type { DaymateApi } from '@shared/types'

const api: DaymateApi = {
  ping: () => ipcRenderer.invoke(IPC.PING),
  getAppInfo: () => ipcRenderer.invoke(IPC.GET_APP_INFO),
  getRobotState: () => ipcRenderer.invoke(IPC.GET_ROBOT_STATE),
  setRobotState: (state) => ipcRenderer.invoke(IPC.SET_ROBOT_STATE, state),
  openWindow: (name) => ipcRenderer.invoke(IPC.OPEN_WINDOW, name),
  openWorkbenchAt: (page) => ipcRenderer.invoke(IPC.OPEN_WORKBENCH_AT, page),
  quitApp: () => ipcRenderer.invoke(IPC.APP_QUIT),
  setRobotView: (view) => ipcRenderer.invoke(IPC.SET_ROBOT_VIEW, view),

  // Robot surface (M4) — main pushes live state + proactive bubbles.
  onRobotStateChanged: (cb) => {
    const listener = (_e: unknown, state: Parameters<typeof cb>[0]): void => cb(state)
    ipcRenderer.on(IPC.ROBOT_STATE_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.ROBOT_STATE_CHANGED, listener)
  },
  onRobotNotify: (cb) => {
    const listener = (_e: unknown, msg: Parameters<typeof cb>[0]): void => cb(msg)
    ipcRenderer.on(IPC.ROBOT_NOTIFY, listener)
    return () => ipcRenderer.removeListener(IPC.ROBOT_NOTIFY, listener)
  },
  onNavigate: (cb) => {
    const listener = (_e: unknown, page: Parameters<typeof cb>[0]): void => cb(page)
    ipcRenderer.on(IPC.WORKBENCH_NAV, listener)
    return () => ipcRenderer.removeListener(IPC.WORKBENCH_NAV, listener)
  },

  // Routines (M1)
  listRoutines: () => ipcRenderer.invoke(IPC.ROUTINE_LIST),
  runRoutine: (routineId) => ipcRenderer.invoke(IPC.ROUTINE_RUN, routineId),
  listRoutineRuns: (routineId) => ipcRenderer.invoke(IPC.ROUTINE_LIST_RUNS, routineId),
  getRoutineRun: (runId) => ipcRenderer.invoke(IPC.ROUTINE_GET_RUN, runId),
  setRoutineEnabled: (routineId, enabled) =>
    ipcRenderer.invoke(IPC.ROUTINE_SET_ENABLED, routineId, enabled),
  updateRoutine: (routineId, patch) =>
    ipcRenderer.invoke(IPC.ROUTINE_UPDATE, routineId, patch),
  pauseRoutines: () => ipcRenderer.invoke(IPC.ROUTINE_PAUSE_ALL),
  resumeRoutines: () => ipcRenderer.invoke(IPC.ROUTINE_RESUME_ALL),
  createRoutine: (def) => ipcRenderer.invoke(IPC.ROUTINE_CREATE, def),
  deleteRoutine: (routineId) => ipcRenderer.invoke(IPC.ROUTINE_DELETE, routineId),

  // Tasks (M1)
  listTasks: () => ipcRenderer.invoke(IPC.TASK_LIST),
  updateTask: (id, patch) => ipcRenderer.invoke(IPC.TASK_UPDATE, id, patch),

  // Need to Know (M1)
  listNeedToKnow: () => ipcRenderer.invoke(IPC.NEED_TO_KNOW_LIST),

  // Activity (M1)
  listActivity: (runId) => ipcRenderer.invoke(IPC.ACTIVITY_LIST, runId),
  onActivityChanged: (cb) => {
    const listener = (_e: unknown, events: Parameters<typeof cb>[0]): void => cb(events)
    ipcRenderer.on(IPC.ACTIVITY_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.ACTIVITY_CHANGED, listener)
  },

  // Approvals (M2 — Spec §8, §15, §18)
  listApprovals: () => ipcRenderer.invoke(IPC.APPROVAL_LIST),
  getApproval: (id) => ipcRenderer.invoke(IPC.APPROVAL_GET, id),
  approveRequest: (id) => ipcRenderer.invoke(IPC.APPROVAL_APPROVE, id),
  rejectRequest: (id) => ipcRenderer.invoke(IPC.APPROVAL_REJECT, id),
  onApprovalChanged: (cb) => {
    const listener = (_e: unknown, approvals: Parameters<typeof cb>[0]): void => cb(approvals)
    ipcRenderer.on(IPC.APPROVAL_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.APPROVAL_CHANGED, listener)
  },

  // Memory (M5 — Spec §16). Agent proposals land `confirmed:false`; the user
  // confirms them here. Only confirmed items are active (searchable).
  listMemory: () => ipcRenderer.invoke(IPC.MEMORY_LIST),
  saveMemory: (input) => ipcRenderer.invoke(IPC.MEMORY_SAVE, input),
  updateMemory: (id, patch) => ipcRenderer.invoke(IPC.MEMORY_UPDATE, id, patch),
  deleteMemory: (id) => ipcRenderer.invoke(IPC.MEMORY_DELETE, id),
  onMemoryChanged: (cb) => {
    const listener = (_e: unknown, items: Parameters<typeof cb>[0]): void => cb(items)
    ipcRenderer.on(IPC.MEMORY_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.MEMORY_CHANGED, listener)
  },

  // LLM configuration (M3). The key is WRITE-ONLY: it is sent to main and
  // encrypted at rest; it is never read back into the renderer. getLlmConfig
  // returns only { provider, modelId, keyConfigured } (Spec §17.8).
  getLlmConfig: () => ipcRenderer.invoke(IPC.LLM_GET_CONFIG),
  setLlmConfig: (config) => ipcRenderer.invoke(IPC.LLM_SET_CONFIG, config),
  setLlmKey: (key) => ipcRenderer.invoke(IPC.LLM_SET_KEY, key),
  deleteLlmKey: () => ipcRenderer.invoke(IPC.LLM_DELETE_KEY),
  testLlm: () => ipcRenderer.invoke(IPC.LLM_TEST),

  // Gmail (Spec §9) — client_id/secret + tokens are credentials in the
  // SecretStore; these never return a secret to the renderer.
  setGmailClient: (input) => ipcRenderer.invoke(IPC.GMAIL_SET_CLIENT, input),
  getGmailStatus: () => ipcRenderer.invoke(IPC.GMAIL_GET_STATUS),
  connectGmail: () => ipcRenderer.invoke(IPC.GMAIL_CONNECT),
  disconnectGmail: () => ipcRenderer.invoke(IPC.GMAIL_DISCONNECT),
  testGmail: () => ipcRenderer.invoke(IPC.GMAIL_TEST),

  // 163 Mail (Spec §9) — email + 授权码 are credentials in the SecretStore;
  // these never return the 授权码 to the renderer.
  setMail163Client: (input) => ipcRenderer.invoke(IPC.MAIL163_SET_CLIENT, input),
  getMail163Status: () => ipcRenderer.invoke(IPC.MAIL163_GET_STATUS),
  connectMail163: () => ipcRenderer.invoke(IPC.MAIL163_CONNECT),
  disconnectMail163: () => ipcRenderer.invoke(IPC.MAIL163_DISCONNECT),
  testMail163: () => ipcRenderer.invoke(IPC.MAIL163_TEST),

  // Feishu Calendar (Spec §10) — app_id/app_secret + user refresh token are
  // credentials in the SecretStore; these never return a secret to the renderer.
  setFeishuClient: (input) => ipcRenderer.invoke(IPC.FEISHU_SET_CLIENT, input),
  getFeishuStatus: () => ipcRenderer.invoke(IPC.FEISHU_GET_STATUS),
  connectFeishu: () => ipcRenderer.invoke(IPC.FEISHU_CONNECT),
  disconnectFeishu: () => ipcRenderer.invoke(IPC.FEISHU_DISCONNECT),
  testFeishu: () => ipcRenderer.invoke(IPC.FEISHU_TEST),

  // Job applications — the cross-channel funnel panel.
  listApplications: () => ipcRenderer.invoke(IPC.APPLICATION_LIST),
  createApplication: (input) => ipcRenderer.invoke(IPC.APPLICATION_CREATE, input),
  addApplicationEvent: (input) => ipcRenderer.invoke(IPC.APPLICATION_ADD_EVENT, input),
  updateApplicationFields: (id, patch) =>
    ipcRenderer.invoke(IPC.APPLICATION_UPDATE_FIELDS, id, patch),
  fetchJobJd: (applicationId) => ipcRenderer.invoke(IPC.APPLICATION_FETCH_JD, applicationId),
  syncBossApplications: () => ipcRenderer.invoke(IPC.APPLICATION_SYNC_BOSS),
  getBossStatus: () => ipcRenderer.invoke(IPC.BOSS_GET_STATUS),
  loginBoss: () => ipcRenderer.invoke(IPC.BOSS_LOGIN),
  logoutBoss: () => ipcRenderer.invoke(IPC.BOSS_LOGOUT),
  onApplicationChanged: (cb) => {
    const listener = (_e: unknown, views: Parameters<typeof cb>[0]): void => cb(views)
    ipcRenderer.on(IPC.APPLICATION_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.APPLICATION_CHANGED, listener)
  },

  // ── Milestone A: email inference, AI generation, recycle bin, config ──
  syncEmailApplications: () => ipcRenderer.invoke(IPC.APPLICATION_SYNC_EMAIL),
  generateResume: (applicationId) => ipcRenderer.invoke(IPC.APPLICATION_GENERATE_RESUME, applicationId),
  generatePrepMaterial: (applicationId) => ipcRenderer.invoke(IPC.APPLICATION_GENERATE_PREP, applicationId),
  listResumeVersions: (applicationId) => ipcRenderer.invoke(IPC.APPLICATION_LIST_RESUMES, applicationId),
  listPrepMaterials: (applicationId) => ipcRenderer.invoke(IPC.APPLICATION_LIST_PREP, applicationId),
  listInterviewNotes: (query) => ipcRenderer.invoke(IPC.APPLICATION_LIST_INTERVIEW_NOTES, query),
  createInterviewNote: (input) => ipcRenderer.invoke(IPC.APPLICATION_CREATE_INTERVIEW_NOTE, input),
  softDeleteApplication: (id) => ipcRenderer.invoke(IPC.APPLICATION_SOFT_DELETE, id),
  restoreApplication: (id) => ipcRenderer.invoke(IPC.APPLICATION_RESTORE, id),
  purgeApplication: (id) => ipcRenderer.invoke(IPC.APPLICATION_PURGE, id),
  listDeletedApplications: () => ipcRenderer.invoke(IPC.APPLICATION_LIST_DELETED),
  archiveApplication: (id) => ipcRenderer.invoke(IPC.APPLICATION_ARCHIVE, id),
  unarchiveApplication: (id) => ipcRenderer.invoke(IPC.APPLICATION_UNARCHIVE, id),
  listPendingEmailMatches: () => ipcRenderer.invoke(IPC.EMAIL_MATCHES_LIST),
  confirmEmailMatch: (messageId, applicationId) =>
    ipcRenderer.invoke(IPC.EMAIL_MATCH_CONFIRM, messageId, applicationId),
  ignoreEmailMatch: (messageId) => ipcRenderer.invoke(IPC.EMAIL_MATCH_IGNORE, messageId),
  onEmailMatchesChanged: (cb) => {
    const listener = (_e: unknown, matches: Parameters<typeof cb>[0]): void => cb(matches)
    ipcRenderer.on(IPC.EMAIL_MATCHES_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC.EMAIL_MATCHES_CHANGED, listener)
  },
  getJobSearchConfig: () => ipcRenderer.invoke(IPC.JOB_SEARCH_GET_CONFIG),
  setJobSearchConfig: (config) => ipcRenderer.invoke(IPC.JOB_SEARCH_SET_CONFIG, config),
  getApplicationStats: () => ipcRenderer.invoke(IPC.APPLICATION_STATS),
  generateFunnelReview: () => ipcRenderer.invoke(IPC.APPLICATION_GENERATE_FUNNEL_REVIEW),
  fetchJobRecommendations: (opts?: { bucket?: 'intern' | 'campus'; append?: boolean }) =>
    ipcRenderer.invoke(IPC.JOB_RECOMMENDATIONS_FETCH, opts),
  convertJobToApplication: (securityId) => ipcRenderer.invoke(IPC.JOB_CONVERT_TO_APPLICATION, securityId),
  getJobDetail: (securityId: string) => ipcRenderer.invoke(IPC.JOB_DETAIL_GET, securityId),
  // Milestone D — notification prefs + 投递 data export.
  getNotificationPrefs: () => ipcRenderer.invoke(IPC.NOTIFICATION_GET_PREFS),
  setNotificationPrefs: (prefs) => ipcRenderer.invoke(IPC.NOTIFICATION_SET_PREFS, prefs),
  exportApplicationsZip: () => ipcRenderer.invoke(IPC.APPLICATION_EXPORT_ZIP),
  // Milestone E — birth data for the daily 运势 (non-secret settings.json).
  getBirthData: () => ipcRenderer.invoke(IPC.BIRTH_DATA_GET),
  setBirthData: (birth) => ipcRenderer.invoke(IPC.BIRTH_DATA_SET, birth),
  clearBirthData: () => ipcRenderer.invoke(IPC.BIRTH_DATA_CLEAR)
}

// contextIsolation is on; this is the safe way to give the renderer a typed API.
contextBridge.exposeInMainWorld('daymate', api)
