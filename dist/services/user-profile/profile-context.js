import { userProfileManager } from "./user-profile-manager.js";
export function getUserProfileContext(userId) {
    const profile = userProfileManager.getActiveProfile(userId);
    if (!profile) {
        return null;
    }
    const profileData = JSON.parse(profile.profileData);
    const parts = [];
    if (profileData.preferences.length > 0) {
        parts.push("User Preferences:");
        profileData.preferences
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 5)
            .forEach((pref) => {
            parts.push(`- [${pref.category}] ${pref.description}`);
        });
    }
    if (profileData.patterns.length > 0) {
        parts.push("\nUser Patterns:");
        profileData.patterns
            .sort((a, b) => b.frequency - a.frequency)
            .slice(0, 5)
            .forEach((pattern) => {
            parts.push(`- [${pattern.category}] ${pattern.description}`);
        });
    }
    if (profileData.workflows.length > 0) {
        parts.push("\nUser Workflows:");
        profileData.workflows
            .sort((a, b) => b.frequency - a.frequency)
            .slice(0, 3)
            .forEach((workflow) => {
            parts.push(`- ${workflow.description}`);
        });
    }
    if (parts.length === 0) {
        return null;
    }
    return parts.join("\n");
}
