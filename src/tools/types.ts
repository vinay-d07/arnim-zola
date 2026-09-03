export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, any>;
}

export interface ToolContext {
  cwd: string;
  autoApprove: boolean;
  onConfirm?: (description: string) => Promise<boolean>;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  default?: any;
}

export interface JSONSchema {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  requiresConfirmation: boolean;
  execute: (params: any, context: ToolContext) => Promise<ToolResult>;
}

export interface GroqToolFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}
