import { SLASH_COMMAND_SPECS, type SlashCommandSpec } from "./specs.js";

export type ResolvedSlashCommand = {
  spec: SlashCommandSpec;
  name: string;
  args: string[];
};

export function listSlashCommands(): SlashCommandSpec[] {
  return SLASH_COMMAND_SPECS;
}

export function formatSlashCommandName(spec: SlashCommandSpec): string {
  const hint = spec.argumentHint ? ` ${spec.argumentHint}` : "";
  return `/${spec.name}${hint}`;
}

export function formatSlashCommandHelp(): string {
  return SLASH_COMMAND_SPECS.map((spec) => {
    const aliases = spec.aliases.filter(Boolean).map((alias) => `/${alias}`);
    const aliasText = aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
    return `  ${formatSlashCommandName(spec).padEnd(28)} ${spec.summary}${aliasText}`;
  }).join("\n");
}

export function formatCliInteractiveHelp(): string {
  return [
    "  /                      show slash commands",
    ...SLASH_COMMAND_SPECS.map(
      (spec) => `  ${formatSlashCommandName(spec).padEnd(38)} ${spec.summary}`,
    ),
  ].join("\n");
}

export function matchingSlashCommands(query: string): SlashCommandSpec[] {
  const normalized = normalizeSlashToken(query);
  if (!normalized) return SLASH_COMMAND_SPECS;

  return SLASH_COMMAND_SPECS.filter((spec) =>
    commandTokens(spec).some((token) => token.startsWith(normalized)),
  );
}

export function parseSlashCommand(input: string): ResolvedSlashCommand | undefined {
  const [rawCommand = "", ...args] = input.trim().split(/\s+/);
  const normalized = normalizeSlashToken(rawCommand);
  const spec = SLASH_COMMAND_SPECS.find((candidate) => commandTokens(candidate).includes(normalized));

  if (!spec) return undefined;

  return {
    spec,
    name: spec.name,
    args,
  };
}

function normalizeSlashToken(value: string): string {
  return value.trim().replace(/^\/+/, "").toLowerCase();
}

function commandTokens(spec: SlashCommandSpec): string[] {
  return [spec.name, ...spec.aliases].map((token) => token.toLowerCase());
}
