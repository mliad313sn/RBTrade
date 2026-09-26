// Side-effect module: must be imported before anything that loads http/express/pg.
import { startTracing } from './tracing';

startTracing();
