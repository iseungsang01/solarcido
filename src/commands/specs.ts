export type SlashCommandSpec = {
  name: string;
  aliases: string[];
  summary: string;
  argumentHint?: string;
  resumeSupported: boolean;
};

