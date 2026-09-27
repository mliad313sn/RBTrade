/**
 * IRTC R6 (flake: bot-runner kill-switch test): the robot control plane on Redis (kill-switch halt /
 * resume / sync channel, runner events, heartbeats) lives under a configurable prefix,
 * `KORA_ROBOT_CTL_PREFIX` (default `kora:`), shared by the api and the bot runner. Tests and e2e runs
 * use their own prefix, so another runner or api on the same Redis cannot halt or answer them.
 */
export function robotCtlPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return env.KORA_ROBOT_CTL_PREFIX?.trim() || 'kora:';
}
/** Kill switch (goal 03) and robot sync messages. */
export const robotControlChannel = (prefix = robotCtlPrefix()): string => `${prefix}ctl:robots`;
/** What the runner reports (halts with latency, decisions). */
export const robotEventsChannel = (prefix = robotCtlPrefix()): string => `${prefix}robots:events`;
export const robotHeartbeatKey = (robotId: string, prefix = robotCtlPrefix()): string =>
  `${prefix}robots:hb:${robotId}`;
