// https://id.atlassian.com/manage-profile/security/api-tokens
const apiToken = ""
// even with api key it appears that you must be logged in to jira
const domain = "*.atlassian.net"
const currentProject = "T1"
// doesnt appear to require being set before connecting to jira
var email = "*@*.*"
// initials as keys
const imageReplaces = {
  AA: "./images/sm.png",
  AB: "./images/notes.png",
  BA: "./images/programer.png",
  BB: "./images/qa.png",
}
