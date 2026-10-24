export interface DbSchemaColumn {
	name: string;
	dataType: string;
	nullable: boolean;
	isPrimaryKey: boolean;
	isForeignKey: boolean;
}

export interface DbSchemaForeignKey {
	column: string;
	refTable: string;
	refColumn: string;
}

export interface DbSchemaTable {
	name: string;
	schema: string;
	columns: DbSchemaColumn[];
	foreignKeys: DbSchemaForeignKey[];
}

export interface DbSchemaResult {
	tables: DbSchemaTable[];
}
