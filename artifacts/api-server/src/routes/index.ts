import { Router, type IRouter } from "express";
import authRouter from "./auth";
import eventsRouter from "./events";
import guestsRouter from "./guests";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(authRouter);
router.use(eventsRouter);
router.use(guestsRouter);
router.use(healthRouter);

export default router;
