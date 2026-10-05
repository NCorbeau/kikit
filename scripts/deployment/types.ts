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
}

export interface DeployActions {
  list(service: string): Promise<Deployment[]>;
  stop(service: string): Promise<void>;
  upload(service: string): Promise<string>;
  healthy(): Promise<boolean>;
  sleep(): Promise<void>;
  now(): number;
  log(message: string): void;
}
