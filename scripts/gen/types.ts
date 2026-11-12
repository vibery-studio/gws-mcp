/** The subset of the Google Discovery REST description the generator reads. */

export interface DiscoverySchema {
  id?: string;
  type?: string;
  format?: string;
  enum?: string[];
  properties?: Record<string, DiscoverySchema>;
  items?: DiscoverySchema;
  additionalProperties?: DiscoverySchema;
  $ref?: string;
  description?: string;
  default?: string;
  minimum?: string;
  maximum?: string;
}

export interface DiscoveryParam extends DiscoverySchema {
  location: string;
  required?: boolean;
  repeated?: boolean;
  /** Regular expression a path parameter's value must match, e.g. `^accounts/[^/]+$`. */
  pattern?: string;
}

export interface DiscoveryMediaProtocol {
  multipart?: boolean;
  path: string;
}

export interface DiscoveryMethod {
  id: string;
  httpMethod: string;
  path: string;
  description?: string;
  parameters?: Record<string, DiscoveryParam>;
  parameterOrder?: string[];
  request?: { $ref: string };
  response?: { $ref: string };
  scopes?: string[];
  supportsMediaUpload?: boolean;
  mediaUpload?: {
    accept: string[];
    maxSize?: string;
    protocols?: { simple?: DiscoveryMediaProtocol; resumable?: DiscoveryMediaProtocol };
  };
  supportsMediaDownload?: boolean;
  supportsSubscription?: boolean;
}

export interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

export interface DiscoveryDoc extends DiscoveryResource {
  version: string;
  revision: string;
  rootUrl: string;
  servicePath: string;
  /** Global parameters every method accepts (`fields`, `key`, `alt`, ...). */
  parameters?: Record<string, DiscoveryParam>;
  schemas: Record<string, DiscoverySchema>;
}

export interface Unsupported {
  method: string;
  reason: string;
}
