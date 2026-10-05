export interface DeployConfig {
  project: string;
  environment: string;
  appService: string;
  migrationService: string;
  origin: string;
}

export interface Deployment {
  id: string;
  status: string;
  deploymentStopped?: boolean;
  instances?: Array<{ status: string }>;
}

export interface DeployActions {
  list(service: string): Promise<Deployment[]>;
  stop(service: string): Promise<void>;
  upload(service: string): Promise<string>;
  migrationCompleted(id: string): Promise<boolean>;
  healthy(): Promise<boolean>;
  sleep(): Promise<void>;
  now(): number;
  log(message: string): void;
}
