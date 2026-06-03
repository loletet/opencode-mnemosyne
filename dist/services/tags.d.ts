export interface TagInfo {
    tag: string;
    displayName: string;
    userName?: string;
    userEmail?: string;
    projectPath?: string;
    projectName?: string;
    gitRepoUrl?: string;
}
export declare function getGitEmail(): string | null;
export declare function getGitName(): string | null;
export declare function getGitRepoUrl(directory: string): string | null;
export declare function getGitCommonDir(directory: string): string | null;
export declare function getGitTopLevel(directory: string): string | null;
export declare function getProjectRoot(directory: string): string;
export declare function getProjectIdentity(directory: string): string;
export declare function getProjectName(directory: string): string;
export declare function getUserTagInfo(): TagInfo;
export declare function getProjectTagInfo(directory: string): TagInfo;
export declare function getTags(directory: string): {
    user: TagInfo;
    project: TagInfo;
};
//# sourceMappingURL=tags.d.ts.map