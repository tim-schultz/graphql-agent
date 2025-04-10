interface TypeReference {
	kind: string;
	name?: string;
	ofType?: TypeReference;
}

interface SchemaField {
	name: string;
	type: TypeReference;
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
function getTypeName(type: TypeReference | undefined | null): string {
	if (!type) return "unknown";

	if (type.kind === "NON_NULL" || type.kind === "LIST") {
		// Recursively call getTypeName with the nested type, ensuring it's not undefined
		return getTypeName(type.ofType);
	}

	// Return the name if available, otherwise "unknown"
	return type.name ?? "unknown";
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
	for (const type of schemaData.types) {
		if (
			type.kind === "OBJECT" &&
			!type.name.startsWith("__") &&
			!type.name.includes("Aggregate") &&
			!type.name.includes("Fields")
		) {
			entities.add(type.name);

			// Collect fields for this entity
			const fields: string[] = [];

			if (type.fields) {
				for (const field of type.fields) {
					const typeName = getTypeName(field.type);

					// Check if this field references another entity
					if (isForeignKey(field.name)) {
						const referencedEntity = field.name.replace("Id", "");
						// Ensure the referenced entity name follows PascalCase convention before adding relationship
						if (
							entities.has(
								referencedEntity.charAt(0).toUpperCase() +
									referencedEntity.slice(1),
							)
						) {
							relationships.push(
								`    ${type.name} }o--|| ${
									referencedEntity.charAt(0).toUpperCase() +
									referencedEntity.slice(1)
								} : "belongs_to"`,
							);
						}
						fields.push(`        String ${field.name} FK`);
					}
					// Check if this is an object relationship field (excluding base types and potential FKs already handled)
					else if (
						![
							"String",
							"Int",
							"Float",
							"Boolean",
							"ID",
							"numeric",
							"timestamptz",
							"jsonb",
							"uuid",
							"BigInt",
							"Bytes",
							"BigDecimal",
							"Date",
							"DateTime",
						].includes(typeName) &&
						entities.has(typeName) // Ensure the referenced type is a known entity
					) {
						// Handle array relationships (e.g., one-to-many)
						if (
							field.type.kind === "LIST" ||
							(field.type.kind === "NON_NULL" &&
								field.type.ofType?.kind === "LIST")
						) {
							relationships.push(
								`    ${type.name} ||--o{ ${typeName} : "${field.name}"`,
							);
						}
						// Handle single object relationships (e.g., one-to-one or adjusted many-to-one)
						else {
							// Avoid duplicate many-to-one if already handled by FK detection
							if (!field.name.endsWith("Id")) {
								relationships.push(
									`    ${type.name} }o--|| ${typeName} : "${field.name}"`,
								);
							}
						}
						// Optionally add the field itself if it's not just a relation indicator
						// fields.push(`        ${typeName} ${field.name}`);
					} else {
						// Regular field
						const fieldType = typeName; // Use the resolved type name
						const isPrimaryKey = field.name === "id";
						fields.push(
							`        ${fieldType} ${field.name}${isPrimaryKey ? " PK" : ""}`,
						);
					}
				} // End inner for loop
			} // End if (type.fields)

			// Set fields for the entity AFTER processing all its fields
			entityFields.set(type.name, fields);
		} // End outer if (type.kind === "OBJECT")
	} // End outer for loop

	// // Process input types to add filter information
	// for (const type of schemaData.types) {
	// 	if (type.kind === "INPUT_OBJECT" && type.name.endsWith("BoolExp")) {
	// 		const entityName = type.name.replace("BoolExp", "Filter");
	//
	// 		if (!entities.has(entityName)) {
	// 			entities.add(entityName);
	//
	// 			// Add filter fields
	// 			const fields: string[] = [
	// 				`        ${type.name} where`,
	// 				`        ${type.name.replace("BoolExp", "OrderBy")} orderBy`,
	// 				"        Int limit",
	// 				"        Int offset",
	// 			];
	//
	// 			entityFields.set(entityName, fields);
	//
	// 			// Also add the BoolExp type itself
	// 			entities.add(type.name);
	// 			const boolExpFields: string[] = [];
	//
	// 			if (type.inputFields) {
	// 				for (const field of type.inputFields) {
	// 					if (
	// 						field.name !== "_and" &&
	// 					field.name !== "_or" &&
	// 					field.name !== "_not"
	// 				) {
	// 					boolExpFields.push(
	// 						`        ${getTypeName(field.type)} ${field.name}`,
	// 					);
	// 				}
	// 			}
	//
	// 			entityFields.set(type.name, boolExpFields);
	// 		}
	// 	}
	// }

	// Add all relationships to the diagram
	diagram += `${relationships.join("\n")}\n\n`;

	// Add all entities and their fields
	for (const entity of entities) {
		diagram += `    ${entity} {\n`;
		diagram += (entityFields.get(entity) || []).join("\n");
		diagram += "\n    }\n\n";
	}

	return diagram;
}
