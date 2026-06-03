import type { UserProfile, UserProfileChangelog, UserProfileData } from "./types.js";
export declare class UserProfileManager {
    private db;
    private readonly dbPath;
    constructor();
    private initDatabase;
    getActiveProfile(userId: string): UserProfile | null;
    createProfile(userId: string, displayName: string, userName: string, userEmail: string, profileData: UserProfileData, promptsAnalyzed: number): string;
    updateProfile(profileId: string, profileData: UserProfileData, additionalPromptsAnalyzed: number, changeSummary: string): void;
    private addChangelog;
    private cleanupOldChangelogs;
    getProfileChangelogs(profileId: string, limit?: number): UserProfileChangelog[];
    applyConfidenceDecay(profileId: string): void;
    deleteProfile(profileId: string): void;
    getProfileById(profileId: string): UserProfile | null;
    getAllActiveProfiles(): UserProfile[];
    private rowToProfile;
    private rowToChangelog;
    mergeProfileData(existing: UserProfileData, updates: Partial<UserProfileData>): UserProfileData;
    private ensureArray;
}
export declare const userProfileManager: UserProfileManager;
//# sourceMappingURL=user-profile-manager.d.ts.map