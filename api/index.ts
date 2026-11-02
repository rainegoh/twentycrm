// Vercel serverless entry. The Nest server is built first by the vercel.json
// buildCommand (nx build twenty-server → packages/twenty-server/dist).
import { serverlessHandler } from '../packages/twenty-server/dist/serverless';

export default serverlessHandler;
