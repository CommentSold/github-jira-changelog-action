const core = require('@actions/core');
const github = require('@actions/github');
const _ = require('lodash');
const Entities = require('html-entities');
const ejs = require('ejs');
const Haikunator = require('haikunator');
const { SourceControl, Jira } = require('jira-changelog');
const RegExpFromString = require('regexp-from-string');
const resolve = require('path').resolve;

const config = {
  jira: {
    api: {            
      host: core.getInput('jira_host'),
      email: core.getInput('jira_email'),
      token: core.getInput('jira_token'),
  },
  baseUrl: core.getInput('jira_base_url'),
  ticketIDPattern: RegExpFromString(core.getInput('jira_ticket_id_pattern')),
  approvalStatus: ['Current Release Candidate', 'Ready to Deploy', "Ready for QA", "In QA", "QA Feedback"],
  excludeIssueTypes: ['Sub-task'],
  includeIssueTypes: [],
  releaseVersion: core.getInput('release_version'),
  generateNotesOnly: core.getInput('generate_notes_only')
},
sourceControl: {
  defaultRange: {
      to: core.getInput("source_control_range_to"),
      from: core.getInput("source_control_range_from"),
      symmetric: false // if we don't make it non-symmetric, then we'll get changes in master that aren't in the release branch
    },
    gitHubToken: core.getInput("github_token"),
    repoName: core.getInput('repo_name')
  },
};



const template = `
<% if (jira.releaseVersions && jira.releaseVersions.length) {  %>
Release version: <%= jira.releaseVersions[0].name -%>
<% jira.releaseVersions.forEach((release) => { %>
  * <%= release.projectKey %>: <%= jira.baseUrl + '/projects/' + release.projectKey + '/versions/' + release.id -%>
<% }); -%>
<% } %>

The following Tickets are in the RT but are missing values for "RT State"
---------------------
<% tickets.noRT.forEach((ticket, index) => { %>
  *<%= index+1 %>. Dev Card: [<%= ticket.key %>](<%= jira.baseUrl + '/browse/' + ticket.key %>)*

  **<%= ticket.fields.summary %>**

  Description: <%= ticket.fields.customfield_10047 %>
<% }); -%>
<% if (!tickets.noRT.length) {%> ~ None ~ <% } %>


RT Jira Tickets Summary
---------------------
<% tickets.allForRT.forEach((ticket, index) => { %>
  *<%= index+1 %>. Dev Card: [<%= ticket.key %>](<%= jira.baseUrl + '/browse/' + ticket.key %>)*

  **<%= ticket.fields.summary %>**

  Description: <%= ticket.fields.customfield_10047 %>
<% }); -%>
<% if (!tickets.allForRT.length) {%> ~ None ~ <% } %>

Pending Approval
---------------------
<% tickets.pendingByOwner.forEach((owner) => { %>
<%= (owner.slackUser) ? '@'+owner.slackUser.name : owner.email %>
<% owner.tickets.forEach((ticket) => { -%>
  * <%= jira.baseUrl + '/browse/' + ticket.key %> - <%= ticket.fields.status.name %>
<% }); -%>
<% }); -%>
<% if (!tickets.pendingByOwner.length) {%> ~ None. Yay! ~ <% } %>


Other Commits
---------------------
<% commits.noTickets.forEach((commit) => { %>
  * <%= commit.slackUser ? '@'+commit.slackUser.name : commit.authorName %> - [<%= commit.revision.substr(0, 7) %>] - <%= commit.summary -%>
<% }); -%>
<% if (!commits.noTickets.length) {%> ~ None ~ <% } %>
`;


const qaTemplate = `
<% if (jira.releaseVersions && jira.releaseVersions.length) {  %>
Release version: <%= jira.releaseVersions[0].name -%>
<% jira.releaseVersions.forEach((release) => { %>
  * <%= release.projectKey %>: <%= jira.baseUrl + '/projects/' + release.projectKey + '/versions/' + release.id -%>
<% }); -%>
<% } %>

QA Tickets Summary
---------------------

<% tickets.allForQA.forEach((ticket) => { %>
  * [<%= ticket.fields.issuetype.name %>] - [<%= ticket.key %>](<%= jira.baseUrl + '/browse/' + ticket.key %>) <%= ticket.fields.summary -%>\n
  ** QA Notes: <%=ticket.fields.customfield_10079 %>
<% }); -%>
<% if (!tickets.allForQA.length) {%> ~ None ~ <% } %>

Pending Approval
---------------------
<% tickets.pendingByOwner.forEach((owner) => { %>
<%= (owner.slackUser) ? '@'+owner.slackUser.name : owner.email %>
<% owner.tickets.forEach((ticket) => { -%>
  * <%= jira.baseUrl + '/browse/' + ticket.key %> - <%= ticket.fields.status.name %>
<% }); -%>
<% }); -%>
<% if (!tickets.pendingByOwner.length) {%> ~ None. Yay! ~ <% } %>

Other Commits
---------------------
<% commits.noTickets.forEach((commit) => { %>
  * <%= commit.slackUser ? '@'+commit.slackUser.name : commit.authorName %> - [<%= commit.revision.substr(0, 7) %>] - <%= commit.summary -%>
<% }); -%>
<% if (!commits.noTickets.length) {%> ~ None ~ <% } %>
`;

// identify TIER 2 tickets that don't have a value for "RT State"
function nonRTInformation(ticket) {
  let stateFieldValue = ticket.fields.customfield_10048 || [];

  if (stateFieldValue.length <= 0) {
    return true;
  }

  return false;
}

function shouldExcludeTicketFromList(ticket, isQA) { 
  if(ticket.fields.status.name == "Deployed" || ticket.fields.status.name == "Completed" || ticket.fields.status.name == "Done. Follow up?" || ticket.fields.status.name == "Closed") {
    return true;
  }

  if (isQA) {
    return false;
  }

  let stateFieldValue = ticket.fields.customfield_10048 || [];

  if (stateFieldValue.length == 0){
    return true;
  }

  if (stateFieldValue.length == 1) {
    return stateFieldValue[0].value == 'No RT'
  }

  return false;
}

function generateReleaseVersionName() {
  const hasVersion = process.env.VERSION;
  if (hasVersion) {
    return process.env.VERSION;
  } else {
    const haikunator = new Haikunator();
    return haikunator.haikunate();
  }
}

function transformCommitLogs(config, logs) {
  let approvalStatus = config.jira.approvalStatus;
  if (!Array.isArray(approvalStatus)) {
    approvalStatus = [approvalStatus];
  }

  // Tickets and their commits
  const ticketHash = logs.reduce((all, log) => {
    log.tickets.forEach((ticket) => {
      all[ticket.key] = all[ticket.key] || ticket;
      all[ticket.key].commits = all[ticket.key].commits || [];
      all[ticket.key].commits.push(log);
    });
    return all;
  }, {});
  const ticketList = _.sortBy(Object.values(ticketHash), ticket => ticket.fields.issuetype.name);
  let pendingTickets = ticketList.filter(ticket => !approvalStatus.includes(ticket.fields.status.name));

  // Pending ticket owners and their tickets/commits
  const reporters = {};
  pendingTickets.forEach((ticket) => {
    const email = ticket.fields.reporter.emailAddress;
    if (!reporters[email]) {
      reporters[email] = {
        email,
        name: ticket.fields.reporter.displayName,
        slackUser: ticket.slackUser,
        tickets: [ticket]
      };
    } else {
      reporters[email].tickets.push(ticket);
    }
  });
  const pendingByOwner = _.sortBy(Object.values(reporters), item => item.user);

  // Output filtered data
  return {
    commits: {
      all: logs,
      tickets: logs.filter(commit => commit.tickets.length),
      noTickets: logs.filter(commit => !commit.tickets.length)
    },
    tickets: {
      pendingByOwner,
      all: ticketList,
      approved: ticketList.filter(ticket => approvalStatus.includes(ticket.fields.status.name)),
      pending: pendingTickets
    }
  }
}

async function main() {
  try {
    // Get commits for a range
    const source = new SourceControl(config);
    const jira = new Jira(config);

    const path = resolve('./');
    console.log("Test path")
    console.log(path);

    const range = config.sourceControl.defaultRange;
    console.log(`Getting range ${range.from}..${range.to} commit logs`);
    const commitLogs = await source.getCommitLogs('./', range, config.sourceControl.gitHubToken, config.sourceControl.repoName);
    console.log(commitLogs);

    let release = "";
    if(config.jira.generateNotesOnly == "true") {
      console.log('Not generating release version -- generate notes only mode');
    } else {
      console.log('Generating release version');
      release = config.jira.releaseVersion;
      console.log(`Release: ${release}`);
    }

    console.log('Generating Jira changelog from commit logs');
    const changelog = await jira.generate(commitLogs, release);
    console.log('Changelog entry:');
    console.log(changelog);

    console.log('Generating changelog message');
    const data = await transformCommitLogs(config, changelog);

    data.jira = {
      baseUrl: config.jira.baseUrl,
      releaseVersions: jira.releaseVersions,
    };



    // if(config.jira.generateNotesOnly == "true") {
    //   data.tickets.all = data.tickets.all.filter((ticket) => {
    //     return inRelease(ticket, config.jira.releaseVersion);
    //   });
    // }

    data.tickets.noRT = data.tickets.all.filter((ticket) => {
      return nonRTInformation(ticket);
    });

    data.tickets.allForRT = data.tickets.all.filter((ticket) => {
      return !shouldExcludeTicketFromList(ticket, false);
    });

    data.tickets.allForQA = data.tickets.all.filter((ticket) => {
      return !shouldExcludeTicketFromList(ticket, true);
    });

    const entitles = new Entities.AllHtmlEntities();
    const changelogMessage = ejs.render(template, data);
    const qaLogMessage = ejs.render(qaTemplate, data);

    console.log('Changelog message entry:');
    console.log(entitles.decode(changelogMessage));

    console.log('QA log message entry:');
    console.log(entitles.decode(qaLogMessage));

    console.log('Jira tickets: ');
    console.log(data.tickets.all);

    data.tickets.all.forEach((ticket) => {
      console.log(ticket.key);
      console.log("Fix Versions");

      ticket.fields.fixVersions.forEach((fixVersion) => {
        console.log(fixVersion);
      });
    });

    core.setOutput('changelog_message', changelogMessage);
    core.setOutput('qanotes_message', qaLogMessage);

  } catch (error) {
    core.setFailed(error.message);
  }
}

main();
