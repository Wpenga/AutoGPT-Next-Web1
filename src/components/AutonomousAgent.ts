import axios from "axios";
import type { ModelSettings, GuestSettings } from "../utils/types";
import type { Analysis } from "../services/agent-service";
import AgentService from "../services/agent-service";
import {
  DEFAULT_MAX_LOOPS_CUSTOM_API_KEY,
  DEFAULT_MAX_LOOPS_FREE,
  DEFAULT_MAX_LOOPS_PAID,
} from "../utils/constants";
import type { Session } from "next-auth";
import { env } from "../env/client.mjs";
import { v4, v1 } from "uuid";
import type { RequestBody } from "../utils/interfaces";
import {
  AUTOMATIC_MODE,
  PAUSE_MODE,
  AGENT_PLAY,
  AGENT_PAUSE,
  TASK_STATUS_STARTED,
  TASK_STATUS_EXECUTING,
  TASK_STATUS_COMPLETED,
  TASK_STATUS_FINAL,
  MESSAGE_TYPE_TASK,
  MESSAGE_TYPE_GOAL,
  MESSAGE_TYPE_THINKING,
  MESSAGE_TYPE_SYSTEM,
} from "../types/agentTypes";
import type {
  AgentMode,
  Message,
  Task,
  AgentPlaybackControl,
} from "../types/agentTypes";
import { useAgentStore } from "./stores";

const TIMEOUT_LONG = 1000;
const TIMOUT_SHORT = 800;

class AutonomousAgent {
  name: string;
  goal: string;
  renderMessage: (message: Message) => void;
  handlePause: (opts: { agentPlaybackControl?: AgentPlaybackControl }) => void;
  shutdown: () => void;
  modelSettings: ModelSettings;
  customLanguage: string;
  guestSettings: GuestSettings;
  session?: Session;
  _id: string;
  mode: AgentMode;
  playbackControl: AgentPlaybackControl;

  tasks: Task[] = [];
  completedTasks: string[] = [];
  isRunning = true;
  numLoops = 0;

  constructor(
    name: string,
    goal: string,
    renderMessage: (message: Message) => void,
    handlePause: (opts: {
      agentPlaybackControl?: AgentPlaybackControl;
    }) => void,
    shutdown: () => void,
    modelSettings: ModelSettings,
    mode: AgentMode,
    customLanguage: string,
    guestSettings: GuestSettings,
    session?: Session,
    playbackControl?: AgentPlaybackControl
  ) {
    this.name = name;
    this.goal = goal;
    this.renderMessage = renderMessage;
    this.handlePause = handlePause;
    this.shutdown = shutdown;
    this.modelSettings = modelSettings;
    this.customLanguage = customLanguage;
    this.guestSettings = guestSettings;
    this.session = session;
    this._id = v4();
    this.mode = mode || AUTOMATIC_MODE;
    this.playbackControl =
      playbackControl || this.mode == PAUSE_MODE ? AGENT_PAUSE : AGENT_PLAY;
  }

  async run() {
    const { isGuestMode, isValidGuest } = this.guestSettings;
    if (isGuestMode && !isValidGuest && !this.modelSettings.customApiKey) {
      this.sendErrorMessage("errors.invalid-guest-key");
      this.stopAgent();
      return;
    }
    if (this.tasks.length === 0) {
      this.sendGoalMessage();
      this.sendThinkingMessage();

      // Initialize by getting tasks
      try {
        const taskValues = await this.getInitialTasks();
        for (const value of taskValues) {
          await new Promise((r) => setTimeout(r, TIMOUT_SHORT));
          const task: Task = {
            taskId: v1().toString(),
            value,
            status: TASK_STATUS_STARTED,
            type: MESSAGE_TYPE_TASK,
          };
          this.sendMessage(task);
          this.tasks.push(task);
        }
      } catch (e) {
        console.log(e);
        this.sendErrorMessage(getMessageFromError(e));
        this.shutdown();
        return;
      }
    }

    await this.loop();
    if (this.mode === PAUSE_MODE && !this.isRunning) {
      this.handlePause({ agentPlaybackControl: this.playbackControl });
    }
  }

  async loop() {
    console.log(`Loop ${this.numLoops}`);
    console.log(this.tasks);

    this.conditionalPause();

    if (!this.isRunning) {
      return;
    }

    if (this.tasks.length === 0) {
      this.sendCompletedMessage();
      this.shutdown();
      return;
    }

    this.numLoops += 1;
    const maxLoops = this.maxLoops();
    if (this.numLoops > maxLoops) {
      this.sendLoopMessage();
      this.shutdown();
      return;
    }

    // Wait before starting
    await new Promise((r) => setTimeout(r, TIMEOUT_LONG));

    const currentTask = this.tasks.shift() as Task;

    this.sendThinkingMessage(currentTask.taskId);

    // Default to reasoning
    let analysis: Analysis = { action: "reason", arg: "" };

    // If enabled, analyze what tool to use
    if (useAgentStore.getState().isWebSearchEnabled) {
      // Analyze how to execute a task: Reason, web search, other tools...
      analysis = await this.analyzeTask(currentTask.value);
      this.sendAnalysisMessage(analysis);
    }

    // Execute first task
    // Get and remove first task
    this.completedTasks.push(this.tasks[0]?.value || "");

    this.sendMessage({ ...currentTask, status: TASK_STATUS_EXECUTING });

    const result = await this.executeTask(currentTask.value, analysis);
    this.sendMessage({
      ...currentTask,
      info: result,
      status: TASK_STATUS_COMPLETED,
    });

    // Wait before adding tasks
    await new Promise((r) => setTimeout(r, TIMEOUT_LONG));
    this.sendThinkingMessage(currentTask.taskId);

    // Add new tasks
    try {
      const newTasks: Task[] = (
        await this.getAdditionalTasks(currentTask.value, result)
      ).map((value) => {
        const task: Task = {
          taskId: v1().toString(),
          value,
          status: TASK_STATUS_STARTED,
          type: MESSAGE_TYPE_TASK,
          parentTaskId: currentTask.taskId,
        };
        return task;
      });
      this.tasks = newTasks.concat(this.tasks);
      for (const task of newTasks) {
        await new Promise((r) => setTimeout(r, TIMOUT_SHORT));
        // this.tasks.push(task);
        this.sendMessage(task);
      }

      if (newTasks.length == 0) {
        this.sendMessage({ ...currentTask, status: TASK_STATUS_FINAL });
      }
    } catch (e) {
      console.log(e);
      this.sendErrorMessage(`errors.adding-additional-task`);
      this.sendMessage({ ...currentTask, status: TASK_STATUS_FINAL });
    }

    await this.loop();
  }

  private conditionalPause() {
    if (this.mode !== PAUSE_MODE) {
      return;
    }

    // decide whether to pause agent when pause mode is enabled
    this.isRunning = !(this.playbackControl === AGENT_PAUSE);

    // reset playbackControl to pause so agent pauses on next set of task(s)
    if (this.playbackControl === AGENT_PLAY) {
      this.playbackControl = AGENT_PAUSE;
    }
  }

  private maxLoops() {
    const defaultLoops = !!this.session?.user.subscriptionId
      ? DEFAULT_MAX_LOOPS_PAID
      : DEFAULT_MAX_LOOPS_FREE;

    return !!this.modelSettings.customApiKey
      ? this.modelSettings.customMaxLoops || DEFAULT_MAX_LOOPS_CUSTOM_API_KEY
      : defaultLoops;
  }

  async getInitialTasks(): Promise<string[]> {
    if (this.shouldRunClientSide()) {
      //FIXME
      // if (!env.NEXT_PUBLIC_FF_MOCK_MODE_ENABLED) {
      //   await testConnection(this.modelSettings);
      // }
      return await AgentService.startGoalAgent(
        this.modelSettings,
        this.goal,
        this.customLanguage
      );
    }

    const data = {
      modelSettings: this.modelSettings,
      goal: this.goal,
      customLanguage: this.customLanguage,
    };
    const res = await this.post(`/api/agent/start`, data);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-argument
    return res.data.newTasks as string[];
  }

  async getAdditionalTasks(
    currentTask: string,
    result: string
  ): Promise<string[]> {
    const taskValues = this.tasks.map((task) => task.value);

    if (this.shouldRunClientSide()) {
      return await AgentService.createTasksAgent(
        this.modelSettings,
        this.goal,
        taskValues,
        currentTask,
        result,
        this.completedTasks,
        this.customLanguage
      );
    }

    const data = {
      modelSettings: this.modelSettings,
      goal: this.goal,
      tasks: taskValues,
      lastTask: currentTask,
      result: result,
      completedTasks: this.completedTasks,
      customLanguage: this.customLanguage,
    };
    const res = await this.post(`/api/agent/create`, data);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-unsafe-member-access
    return res.data.newTasks as string[];
  }

  async analyzeTask(task: string): Promise<Analysis> {
    if (this.shouldRunClientSide()) {
      return await AgentService.analyzeTaskAgent(
        this.modelSettings,
        this.goal,
        task
      );
    }

    const data = {
      modelSettings: this.modelSettings,
      goal: this.goal,
      task: task,
      customLanguage: this.customLanguage,
    };
    const res = await this.post("/api/agent/analyze", data);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-argument
    return res.data.response as Analysis;
  }

  async executeTask(task: string, analysis: Analysis): Promise<string> {
    // Run search server side since clients won't have a key
    if (this.shouldRunClientSide() && analysis.action !== "search") {
      return await AgentService.executeTaskAgent(
        this.modelSettings,
        this.goal,
        task,
        analysis,
        this.customLanguage
      );
    }

    const data = {
      modelSettings: this.modelSettings,
      goal: this.goal,
      task: task,
      analysis: analysis,
      customLanguage: this.customLanguage,
    };
    const res = await this.post("/api/agent/execute", data);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-argument
    return res.data.response as string;
  }

  private async post(url: string, data: RequestBody) {
    try {
      return await axios.post(url, data);
    } catch (e) {
      this.shutdown();

      if (axios.isAxiosError(e) && e.response?.status === 429) {
        this.sendErrorMessage("rate-limit");
      }

      throw e;
    }
  }

  private shouldRunClientSide() {
    return !!this.modelSettings.customApiKey;
  }

  updatePlayBackControl(newPlaybackControl: AgentPlaybackControl) {
    this.playbackControl = newPlaybackControl;
  }

  updateIsRunning(isRunning: boolean) {
    this.isRunning = isRunning;
  }

  stopAgent() {
    this.sendManualShutdownMessage();
    this.isRunning = false;
    this.shutdown();
    return;
  }

  sendMessage(message: Message) {
    if (this.isRunning) {
      this.renderMessage(message);
    }
  }

  sendGoalMessage(taskId?: string) {
    this.sendMessage({
      type: MESSAGE_TYPE_GOAL,
      value: this.goal,
      taskId,
    });
  }

  sendLoopMessage() {
    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value:
        this.modelSettings.customApiKey !== ""
          ? "errors.loop-with-filled-customApiKey"
          : "errors.loop-with-empty-customApiKey",
    });
  }

  sendManualShutdownMessage() {
    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value: "manually-shutdown",
    });
  }

  sendCompletedMessage() {
    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value: "all-tasks-completed",
    });
  }

  sendAnalysisMessage(analysis: Analysis, taskId?: string) {
    // Hack to send message with generic test. Should use a different type in the future
    let message = "🧠 Generating response...";
    if (analysis.action == "search") {
      message = `🌐 Searching the web for "${analysis.arg}"...`;
    }

    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value: message,
      taskId,
    });
  }

  sendThinkingMessage(taskId?: string) {
    this.sendMessage({
      type: MESSAGE_TYPE_THINKING,
      value: "",
      taskId: taskId,
    });
  }

  sendErrorMessage(error: string) {
    this.sendMessage({ type: MESSAGE_TYPE_SYSTEM, value: error });
  }
}

const testConnection = async (modelSettings: ModelSettings) => {
  // A dummy connection to see if the key is valid
  // Can't use LangChain / OpenAI libraries to test because they have retries in place
  return await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: modelSettings.customModelName,
      messages: [{ role: "user", content: "Say this is a test" }],
      max_tokens: 7,
      temperature: 0,
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${modelSettings.customApiKey ?? ""}`,
      },
    }
  );
};

const getMessageFromError = (e: unknown) => {
  let message = "errors.accessing-apis";
  if (axios.isAxiosError(e)) {
    const axiosError = e;
    if (axiosError.response?.status === 429) {
      message = "errors.accessing-using-apis";
    }
    if (axiosError.response?.status === 404) {
      message = "errors.accessing-gtp4";
    }
  } else {
    message = "errors.initial-tasks";
  }
  return message;
};

export default AutonomousAgent;
