export type Identity = { pid: number; birth: string; boot: string };
export type Port = { address: string; port: number };
export type Process = Identity & {
  parent: number; group: number; session: number; state: string;
  cwd?: string; image?: string; cpuTime?: number; rss?: number; ports: Port[];
  cpuPercent?: number; projectHint?: string;
};
export type Recipe = {
  argv: string[]; cwd: string; env: string[];
  dependencies: string[]; ready?: Port; stop?: string[]; timeout: number;
  restart: 'never' | 'on-failure'; cgroup?: string; containers: Container[];
  systemd: { unit: string; shared: boolean }[];
  supervisors: { kind: 'launchd' | 'scm' | 'task'; name: string; shared: boolean; plist?: string }[];
};
export type Container = { project: string; service: string; shared: boolean };
export type Member = Identity & { source: 'adopted' | 'launched' | 'contained'; suspended?: boolean };
export type Project = {
  id: string; name: string; cwd: string; state: string; members: Member[];
  excluded: Identity[]; root?: Identity; recipe?: Recipe; job?: string; cgroup?: string;
  frozenContainers?: string[]; stoppedContainers?: string[]; sleepingIntent?: boolean;
  frozenUnits?: string[]; stoppedUnits?: string[];
  supervisorPins?: Record<string, string>; pausedSupervisors?: string[]; stoppedSupervisors?: string[]; disabledTasks?: string[];
};
export type Outcome = { target: string; status: string; code?: string; message?: string };
export type Operation = {
  id: string; action: string; projects: string[]; status: string;
  started: string; ended?: string; outcomes: Outcome[]; pending?: string;
};
