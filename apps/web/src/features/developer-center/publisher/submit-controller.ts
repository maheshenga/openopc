import type {
  DeveloperModuleArtifact,
  DeveloperModuleReleaseAccountOptions,
  DeveloperModuleReleaseSubmission,
  DeveloperModuleValidationIssue,
  DeveloperModuleValidationResult,
  SubmitDeveloperModuleReleaseInput,
} from '@kortix/sdk';

import { parseDeveloperModuleInput } from '../model';

export type SubmitControllerStage = 'input' | 'confirm' | 'submitting' | 'submitted';
export type SubmitInputErrorCode =
  | 'EMPTY_INPUT'
  | 'INPUT_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_ROOT';

export interface DeveloperModuleSubmitControllerState {
  stage: SubmitControllerStage;
  text: string;
  parsedItem: Record<string, unknown> | null;
  issues: DeveloperModuleValidationIssue[];
  inputErrorCode: SubmitInputErrorCode | null;
  submission: DeveloperModuleReleaseSubmission | null;
}

export interface DeveloperModuleSubmitControllerDependencies {
  validate: (item: Record<string, unknown>) => Promise<DeveloperModuleValidationResult>;
  submit: (
    item: Record<string, unknown>,
    accountId: string,
  ) => Promise<DeveloperModuleReleaseSubmission>;
}

export function createArtifactBackedDeveloperModuleSubmit(dependencies: {
  createArtifact: (
    item: Record<string, unknown>,
    options: DeveloperModuleReleaseAccountOptions,
  ) => Promise<Pick<DeveloperModuleArtifact, 'artifact_id'>>;
  submitRelease: (
    input: SubmitDeveloperModuleReleaseInput,
  ) => Promise<DeveloperModuleReleaseSubmission>;
}): DeveloperModuleSubmitControllerDependencies['submit'] {
  return async (item, accountId) => {
    const artifact = await dependencies.createArtifact(item, { accountId });
    return dependencies.submitRelease({ artifactId: artifact.artifact_id, accountId });
  };
}

function cleanIssues(
  issues: readonly DeveloperModuleValidationIssue[],
): DeveloperModuleValidationIssue[] {
  return issues
    .filter(
      (issue) =>
        (issue.severity === 'error' || issue.severity === 'warning') &&
        typeof issue.path === 'string' &&
        typeof issue.message === 'string',
    )
    .map((issue) => ({
      severity: issue.severity,
      path: issue.path,
      message: issue.message,
    }));
}

export function createDeveloperModuleSubmitController(
  dependencies: DeveloperModuleSubmitControllerDependencies,
) {
  let state: DeveloperModuleSubmitControllerState = {
    stage: 'input',
    text: '',
    parsedItem: null,
    issues: [],
    inputErrorCode: null,
    submission: null,
  };
  let pendingSubmit: Promise<DeveloperModuleReleaseSubmission> | null = null;

  const getState = (): DeveloperModuleSubmitControllerState => ({
    ...state,
    issues: [...state.issues],
  });

  const setText = (text: string): DeveloperModuleSubmitControllerState => {
    state = {
      stage: 'input',
      text,
      parsedItem: null,
      issues: [],
      inputErrorCode: null,
      submission: null,
    };
    return getState();
  };

  const validate = async (): Promise<DeveloperModuleSubmitControllerState> => {
    const textSnapshot = state.text;
    const parsed = parseDeveloperModuleInput(textSnapshot);
    if (!parsed.ok) {
      state = {
        ...state,
        stage: 'input',
        parsedItem: null,
        issues: [],
        inputErrorCode: parsed.code,
      };
      return getState();
    }

    const result = await dependencies.validate(parsed.item);
    if (state.text !== textSnapshot) return getState();

    const issues = cleanIssues(result.issues);
    state = result.valid
      ? { ...state, stage: 'confirm', parsedItem: parsed.item, issues, inputErrorCode: null }
      : { ...state, stage: 'input', parsedItem: null, issues, inputErrorCode: null };
    return getState();
  };

  const confirm = (accountId: string): Promise<DeveloperModuleReleaseSubmission> => {
    if (pendingSubmit) return pendingSubmit;
    if (state.stage !== 'confirm' || !state.parsedItem) {
      return Promise.reject(new Error('SUBMISSION_NOT_VALIDATED'));
    }

    const itemSnapshot = state.parsedItem;
    state = { ...state, stage: 'submitting' };
    pendingSubmit = dependencies
      .submit(itemSnapshot, accountId)
      .then((result) => {
        state = { ...state, stage: 'submitted', submission: result };
        return result;
      })
      .catch((error) => {
        state = { ...state, stage: 'confirm' };
        throw error;
      })
      .finally(() => {
        pendingSubmit = null;
      });
    return pendingSubmit;
  };

  return { getState, setText, validate, confirm };
}
