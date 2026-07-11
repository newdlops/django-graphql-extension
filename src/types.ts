export type Framework = 'graphene' | 'strawberry' | 'ariadne' | 'graphql-schema';

export interface FieldArgInfo {
  name: string;
  type: string;
  required: boolean;
}

export interface FieldInfo {
  /** Python/source-level field name used for navigation and display. */
  name: string;
  /**
   * Exact GraphQL wire name when it differs from source naming semantics, or
   * when the source itself is SDL/Ariadne and is already expressed in GraphQL
   * names.  Resolution checks this before applying camelCase → snake_case.
   */
  graphqlName?: string;
  /** Internal scanner hint that this location is an executable resolver. */
  isResolver?: boolean;
  fieldType: string;
  resolvedType?: string;
  args?: FieldArgInfo[];
  filePath: string;
  lineNumber: number;
  /**
   * Set by resolveInheritedFields to the name of the class that **declares**
   * the field. Undefined for fields declared directly on the owning class.
   * Drives: (1) field-index routing to the true owner, (2) inspector "origin"
   * display, (3) click-to-source navigation.
   */
  definedIn?: string;
}

export interface ClassInfo {
  /** Python/source class name. */
  name: string;
  /** Exact GraphQL type name when explicitly overridden in the framework. */
  graphqlName?: string;
  baseClasses: string[];
  framework: Framework;
  filePath: string;
  lineNumber: number;
  fields: FieldInfo[];
  kind: 'query' | 'mutation' | 'subscription' | 'type';
  /**
   * True only for the concrete class/type passed to the schema as its
   * Query, Mutation, or Subscription root.
   *
   * `kind` is intentionally broader: scanners also use it to group query
   * mixins and mutation payload classes in the explorer.  Treating every
   * such class as an operation root makes fields on returned object types
   * look like valid top-level GraphQL fields, so resolution must use this
   * marker when it is available.
   */
  isSchemaRoot?: boolean;
  /**
   * A mixin/base whose fields are exposed by an explicitly configured schema
   * root.  Large Graphene schemas often compose Query/Mutation from many such
   * classes; keeping this distinct from `kind` excludes returned payload types
   * without losing legitimate inherited root fields.
   */
  isSchemaRootContributor?: boolean;
}

export interface SchemaInfo {
  name: string;
  filePath: string;
  queries: ClassInfo[];
  mutations: ClassInfo[];
  subscriptions: ClassInfo[];
  types: ClassInfo[];
}

export interface ProjectInfo {
  rootDir: string;
  frameworks: Framework[];
}
