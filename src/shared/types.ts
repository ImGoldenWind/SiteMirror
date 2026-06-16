export type CrawlStatus = "idle" | "running" | "complete" | "error";

export interface CrawlRequest {
  startUrl: string;
  maxDepth: number;
  outputDir: string;
}

export interface CrawlProgress {
  processed: number;
  queued: number;
  totalDiscovered: number;
  percent: number;
}

export interface LinkIndexEntry {
  url: string;
  depth: number;
  localHtml: string;
  links: string[];
  images: string[];
  status: "success" | "error";
  error?: string;
  httpStatus?: number;
  screenshot?: string;
}

export interface CrawlComplete {
  outputDir: string;
  indexPath: string;
  localUrl: string;
  pages: number;
  errors: number;
  engine?: "browsertrix" | "legacy";
  archivePath?: string;
}

export interface SiteMirrorApi {
  selectOutputDirectory: () => Promise<string | null>;
  startCrawl: (request: CrawlRequest) => Promise<CrawlComplete>;
  openSavedCopy: () => Promise<void>;
  openSavedCopyExternal: () => Promise<void>;
  onLog: (callback: (line: string) => void) => () => void;
  onProgress: (callback: (progress: CrawlProgress) => void) => () => void;
}
