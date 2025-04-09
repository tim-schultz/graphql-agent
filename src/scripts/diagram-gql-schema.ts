import * as fs from "fs";

interface SchemaField {
	name: string;
	type: {
		kind: string;
		name?: string;
		ofType?: any;
	};
	description?: string;
}

interface SchemaType {
	kind: string;
	name: string;
	description?: string;
	fields?: SchemaField[];
	inputFields?: SchemaField[];
}

interface SchemaData {
	types: SchemaType[];
}

// Function to get the actual type name, handling NON_NULL and LIST wrappers
function getTypeName(type: any): string {
	if (!type) return "unknown";

	if (type.kind === "NON_NULL" || type.kind === "LIST") {
		return getTypeName(type.ofType);
	}

	return type.name;
}

// Function to detect if a field is likely a foreign key
function isForeignKey(fieldName: string): boolean {
	return fieldName.endsWith("Id") && fieldName !== "id";
}

// Main function to generate the Mermaid diagram
export function generateMermaidDiagram(schemaData: SchemaData): string {
	let diagram = "erDiagram\n";

	// Track relationships
	const relationships: string[] = [];
	const entities: Set<string> = new Set();
	const entityFields: Map<string, string[]> = new Map();

	// Process object types first to identify entities
	schemaData.types.forEach((type) => {
		if (
			type.kind === "OBJECT" &&
			!type.name.startsWith("__") &&
			!type.name.includes("Aggregate") &&
			!type.name.includes("Fields")
		) {
			entities.add(type.name);

			// Collect fields for this entity
			const fields: string[] = [];

			type.fields?.forEach((field) => {
				const typeName = getTypeName(field.type);

				// Check if this field references another entity
				if (isForeignKey(field.name)) {
					const referencedEntity = field.name.replace("Id", "");
					if (
						referencedEntity.charAt(0).toUpperCase() +
							referencedEntity.slice(1) ===
						referencedEntity
					) {
						relationships.push(
							`    ${type.name} }o--|| ${referencedEntity} : "belongs_to"`,
						);
					}
					fields.push(`        String ${field.name} FK`);
				}
				// Check if this is an object relationship field
				else if (
					typeName !== "String" &&
					typeName !== "Int" &&
					typeName !== "Float" &&
					typeName !== "Boolean" &&
					typeName !== "ID" &&
					typeName !== "numeric" &&
					typeName !== "timestamptz" &&
					typeName !== "jsonb" &&
					typeName !== "application_status"
				) {
					// Handle array relationships
					if (
						field.type.kind === "NON_NULL" &&
						field.type.ofType?.kind === "LIST"
					) {
						relationships.push(`    ${type.name} ||--o{ ${typeName} : "has"`);
					}
					// Handle object relationships
					else {
						relationships.push(
							`    ${type.name} }o--|| ${typeName} : "references"`,
						);
					}
				} else {
					// Regular field
					const fieldType = typeName;
					const isPrimaryKey = field.name === "id";

					fields.push(
						`        ${fieldType} ${field.name}${isPrimaryKey ? " PK" : ""}`,
					);
				}
			});

			entityFields.set(type.name, fields);
		}
	});

	// Process input types to add filter information
	schemaData.types.forEach((type) => {
		if (type.kind === "INPUT_OBJECT" && type.name.endsWith("BoolExp")) {
			const entityName = type.name.replace("BoolExp", "Filter");

			if (!entities.has(entityName)) {
				entities.add(entityName);

				// Add filter fields
				const fields: string[] = [
					`        ${type.name} where`,
					`        ${type.name.replace("BoolExp", "OrderBy")} orderBy`,
					"        Int limit",
					"        Int offset",
				];

				entityFields.set(entityName, fields);

				// Also add the BoolExp type itself
				entities.add(type.name);
				const boolExpFields: string[] = [];

				type.inputFields?.forEach((field) => {
					if (
						field.name !== "_and" &&
						field.name !== "_or" &&
						field.name !== "_not"
					) {
						boolExpFields.push(
							`        ${getTypeName(field.type)} ${field.name}`,
						);
					}
				});

				entityFields.set(type.name, boolExpFields);
			}
		}
	});

	// Add all relationships to the diagram
	diagram += `${relationships.join("\n")}\n\n`;

	// Add all entities and their fields
	entities.forEach((entity) => {
		diagram += `    ${entity} {\n`;
		diagram += (entityFields.get(entity) || []).join("\n");
		diagram += "\n    }\n\n";
	});

	return diagram;
}
