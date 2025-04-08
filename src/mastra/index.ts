
import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
// Import both workflow and agent from the workflows file
import { gitcoinQueryWorkflow, gitcoinAgent } from './workflows'; 

export const mastra = new Mastra({
  workflows: { gitcoinQueryWorkflow }, 
  agents: { gitcoinAgent }, 
  logger: createLogger({
    name: 'Mastra',
    level: 'info',
  }),
});