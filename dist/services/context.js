import { CONFIG } from "../config.js";
import { getUserProfileContext } from "./user-profile/profile-context.js";
export function formatContextForPrompt(userId, projectMemories) {
    const parts = ["[MEMORY]"];
    if (CONFIG.injectProfile && userId) {
        const profileContext = getUserProfileContext(userId);
        if (profileContext) {
            parts.push("\n" + profileContext);
        }
    }
    const projectResults = projectMemories.results || [];
    if (projectResults.length > 0) {
        parts.push("\nProject Knowledge:");
        projectResults.forEach((mem) => {
            const similarity = Math.round(mem.similarity * 100);
            const content = mem.memory || mem.chunk || "";
            parts.push(`- [${similarity}%] ${content}`);
        });
    }
    if (parts.length === 1) {
        return "";
    }
    return parts.join("\n");
}
