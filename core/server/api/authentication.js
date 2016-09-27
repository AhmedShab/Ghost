var _                = require('lodash'),
    validator        = require('validator'),
    Promise          = require('bluebird'),
    pipeline         = require('../utils/pipeline'),
    settings         = require('./settings'),
    mail             = require('./../mail'),
    apiMail          = require('./mail'),
    utils            = require('../utils'),
    errors           = require('../errors'),
    models           = require('../models'),
    events           = require('../events'),
    config           = require('../config'),
    i18n             = require('../i18n'),
    authentication;

/**
 * Returns setup status
 *
 * @return {Promise<Boolean>}
 */
function checkSetup() {
    return authentication.isSetup().then(function then(result) {
        return result.setup[0].status;
    });
}

/**
 * Allows an assertion to be made about setup status.
 *
 * @param  {Boolean} status True: setup must be complete. False: setup must not be complete.
 * @return {Function} returns a "task ready" function
 */
function assertSetupCompleted(status) {
    return function checkPermission(__) {
        return checkSetup().then(function then(isSetup) {
            if (isSetup === status) {
                return __;
            }

            var completed = i18n.t('errors.api.authentication.setupAlreadyCompleted'),
                notCompleted = i18n.t('errors.api.authentication.setupMustBeCompleted');

            function throwReason(reason) {
                throw new errors.NoPermissionError(reason);
            }

            if (isSetup) {
                throwReason(completed);
            } else {
                throwReason(notCompleted);
            }
        });
    };
}

function setupTasks(setupData) {
    var tasks;

    function validateData(setupData) {
        return utils.checkObject(setupData, 'setup').then(function then(checked) {
            var data = checked.setup[0];

            return {
                name: data.name,
                email: data.email,
                password: data.password,
                blogTitle: data.blogTitle,
                status: 'active'
            };
        });
    }

    function setupUser(userData) {
        var context = {context: {internal: true}},
            User = models.User;

        return User.findOne({role: 'Owner', status: 'all'}).then(function then(owner) {
            if (!owner) {
                throw new errors.InternalServerError(
                    i18n.t('errors.api.authentication.setupUnableToRun')
                );
            }

            return User.setup(userData, _.extend({id: owner.id}, context));
        }).then(function then(user) {
            return {
                user: user,
                userData: userData
            };
        });
    }

    function doSettings(data) {
        var user = data.user,
            blogTitle = data.userData.blogTitle,
            context = {context: {user: data.user.id}},
            userSettings;

        if (!blogTitle || typeof blogTitle !== 'string') {
            return user;
        }

        userSettings = [
            {key: 'title', value: blogTitle.trim()},
            {key: 'description', value: i18n.t('common.api.authentication.sampleBlogDescription')}
        ];

        return settings.edit({settings: userSettings}, context).return(user);
    }

    function formatResponse(user) {
        return user.toJSON({context: {internal: true}});
    }

    tasks = [
        validateData,
        setupUser,
        doSettings,
        formatResponse
    ];

    return pipeline(tasks, setupData);
}

/**
 * ## Authentication API Methods
 *
 * **See:** [API Methods](index.js.html#api%20methods)
 */
authentication = {
    createTokens: function createTokens(data, options) {
        var localAccessToken = utils.uid(191),
            localRefreshToken = utils.uid(191),
            accessExpires = Date.now() + utils.ONE_HOUR_MS,
            refreshExpires = Date.now() + utils.ONE_WEEK_MS,
            client = options.context.client_id,
            user = options.context.user;

        return models.Accesstoken.add({
            token: localAccessToken,
            user_id: user,
            client_id: client,
            expires: accessExpires
        }).then(function () {
            return models.Refreshtoken.add({
                token: localRefreshToken,
                user_id: user,
                client_id: client,
                expires: refreshExpires
            });
        }).then(function () {
            return {
                access_token: localAccessToken,
                refresh_token: localRefreshToken,
                expires_in: accessExpires
            }
        });
    },

    /**
     * @description generate a reset token for a given email address
     * @param {Object} resetRequest
     * @returns {Promise<Object>} message
     */
    generateResetToken: function generateResetToken(resetRequest) {
        var tasks;

        function validateRequest(resetRequest) {
            return utils.checkObject(resetRequest, 'passwordreset').then(function then(data) {
                var email = data.passwordreset[0].email;

                if (typeof email !== 'string' || !validator.isEmail(email)) {
                    throw new errors.BadRequestError(
                        i18n.t('errors.api.authentication.noEmailProvided')
                    );
                }

                return email;
            });
        }

        function generateToken(email) {
            var settingsQuery = {context: {internal: true}, key: 'dbHash'};

            return settings.read(settingsQuery).then(function then(response) {
                var dbHash = response.settings[0].value,
                    expiresAt = Date.now() + utils.ONE_DAY_MS;

                return models.User.generateResetToken(email, expiresAt, dbHash);
            }).then(function then(resetToken) {
                return {
                    email: email,
                    resetToken: resetToken
                };
            });
        }

        function sendResetNotification(data) {
            var baseUrl = config.get('forceAdminSSL') ? (config.get('urlSSL') || config.get('url')) : config.get('url'),
                resetUrl = baseUrl.replace(/\/$/, '') +
                    '/ghost/reset/' +
                    utils.encodeBase64URLsafe(data.resetToken) + '/';

            return mail.utils.generateContent({
                data: {
                    resetUrl: resetUrl
                },
                template: 'reset-password'
            }).then(function then(content) {
                var payload = {
                    mail: [{
                        message: {
                            to: data.email,
                            subject: i18n.t('common.api.authentication.mail.resetPassword'),
                            html: content.html,
                            text: content.text
                        },
                        options: {}
                    }]
                };

                return apiMail.send(payload, {context: {internal: true}});
            });
        }

        function formatResponse() {
            return {
                passwordreset: [
                    {message: i18n.t('common.api.authentication.mail.checkEmailForInstructions')}
                ]
            };
        }

        tasks = [
            assertSetupCompleted(true),
            validateRequest,
            generateToken,
            sendResetNotification,
            formatResponse
        ];

        return pipeline(tasks, resetRequest);
    },

    /**
     * ## Reset Password
     * reset password if a valid token and password (2x) is passed
     * @param {Object} resetRequest
     * @returns {Promise<Object>} message
     */
    resetPassword: function resetPassword(resetRequest) {
        var tasks;

        function validateRequest(resetRequest) {
            return utils.checkObject(resetRequest, 'passwordreset');
        }

        function doReset(resetRequest) {
            var settingsQuery = {context: {internal: true}, key: 'dbHash'},
                data = resetRequest.passwordreset[0],
                resetToken = data.token,
                newPassword = data.newPassword,
                ne2Password = data.ne2Password;

            return settings.read(settingsQuery).then(function then(response) {
                return models.User.resetPassword({
                    token: resetToken,
                    newPassword: newPassword,
                    ne2Password: ne2Password,
                    dbHash: response.settings[0].value
                });
            }).catch(function (error) {
                throw new errors.UnauthorizedError(error.message);
            });
        }

        function formatResponse() {
            return {
                passwordreset: [
                    {message: i18n.t('common.api.authentication.mail.passwordChanged')}
                ]
            };
        }

        tasks = [
            assertSetupCompleted(true),
            validateRequest,
            doReset,
            formatResponse
        ];

        return pipeline(tasks, resetRequest);
    },

    /**
     * ### Accept Invitation
     * @param {Object} invitation an invitation object
     * @returns {Promise<Object>}
     */
    acceptInvitation: function acceptInvitation(invitation) {
        var tasks, invite, options = {context: {internal: true}};

        function validateInvitation(invitation) {
            return utils.checkObject(invitation, 'invitation')
                .then(function () {
                    if (!invitation.invitation[0].token) {
                        return Promise.reject(new errors.ValidationError(i18n.t('errors.api.authentication.noTokenProvided')));
                    }

                    if (!invitation.invitation[0].email) {
                        return Promise.reject(new errors.ValidationError(i18n.t('errors.api.authentication.noEmailProvided')));
                    }

                    if (!invitation.invitation[0].password) {
                        return Promise.reject(new errors.ValidationError(i18n.t('errors.api.authentication.noPasswordProvided')));
                    }

                    if (!invitation.invitation[0].name) {
                        return Promise.reject(new errors.ValidationError(i18n.t('errors.api.authentication.noNameProvided')));
                    }

                    return invitation;
                });
        }

        function processInvitation(invitation) {
            var data = invitation.invitation[0], inviteToken = utils.decodeBase64URLsafe(data.token);

            return models.Invite.findOne({token: inviteToken, status: 'sent'}, _.merge({}, {include: ['roles']}, options))
                .then(function (_invite) {
                    invite = _invite;

                    if (!invite) {
                        throw new errors.NotFoundError(i18n.t('errors.api.invites.inviteNotFound'));
                    }

                    if (invite.get('expires') < Date.now()) {
                        throw new errors.NotFoundError(i18n.t('errors.api.invites.inviteExpired'));
                    }

                    return models.User.add({
                        email: data.email,
                        name: data.name,
                        password: data.password,
                        roles: invite.toJSON().roles
                    }, options);
                })
                .then(function () {
                    return invite.destroy(options);
                });
        }

        function formatResponse() {
            return {
                invitation: [
                    {message: i18n.t('common.api.authentication.mail.invitationAccepted')}
                ]
            };
        }

        tasks = [
            assertSetupCompleted(true),
            validateInvitation,
            processInvitation,
            formatResponse
        ];

        return pipeline(tasks, invitation);
    },

    /**
     * ### Check for invitation
     * @param {Object} options
     * @returns {Promise<Object>} An invitation status
     */
    isInvitation: function isInvitation(options) {
        var tasks,
            localOptions = _.cloneDeep(options || {});

        function processArgs(options) {
            var email = options.email;

            if (typeof email !== 'string' || !validator.isEmail(email)) {
                throw new errors.BadRequestError(
                    i18n.t('errors.api.authentication.invalidEmailReceived')
                );
            }

            return email;
        }

        function checkInvitation(email) {
            return models.Invite
                .where({email: email, status: 'sent'})
                .count('id')
                .then(function then(count) {
                    return !!count;
                });
        }

        function formatResponse(isInvited) {
            return {invitation: [{valid: isInvited}]};
        }

        tasks = [
            processArgs,
            assertSetupCompleted(true),
            checkInvitation,
            formatResponse
        ];

        return pipeline(tasks, localOptions);
    },

    /**
     * Checks the setup status
     * @return {Promise}
     */
    isSetup: function isSetup() {
        var tasks,
            validStatuses = ['active', 'warn-1', 'warn-2', 'warn-3', 'warn-4', 'locked'];

        function checkSetupStatus() {
            return models.User
                .where('status', 'in', validStatuses)
                .count('id')
                .then(function (count) {
                    return !!count;
                });
        }

        function formatResponse(isSetup) {
            return {setup: [
                {
                    status: isSetup,
                    // Pre-populate from config if, and only if the values exist in config.
                    title: config.title || undefined,
                    name: config.user_name || undefined,
                    email: config.user_email || undefined
                }
            ]};
        }

        tasks = [
            checkSetupStatus,
            formatResponse
        ];

        return pipeline(tasks);
    },

    /**
     * Executes the setup tasks and sends an email to the owner
     * @param  {Object} setupDetails
     * @return {Promise<Object>} a user api payload
     */
    setup: function setup(setupDetails) {
        var tasks;

        function doSetup(setupDetails) {
            return setupTasks(setupDetails);
        }

        function sendNotification(setupUser) {
            var data = {
                ownerEmail: setupUser.email
            };

            events.emit('setup.completed', setupUser);

            return mail.utils.generateContent({data: data, template: 'welcome'})
                .then(function then(content) {
                    var message = {
                            to: setupUser.email,
                            subject: i18n.t('common.api.authentication.mail.yourNewGhostBlog'),
                            html: content.html,
                            text: content.text
                        },
                        payload = {
                            mail: [{
                                message: message,
                                options: {}
                            }]
                        };

                    apiMail.send(payload, {context: {internal: true}}).catch(function (error) {
                        errors.logError(
                            error.message,
                            i18n.t(
                                'errors.api.authentication.unableToSendWelcomeEmail'
                            ),
                            i18n.t('errors.api.authentication.checkEmailConfigInstructions', {url: 'http://support.ghost.org/mail/'})
                        );
                    });
                })
                .return(setupUser);
        }

        function formatResponse(setupUser) {
            return {users: [setupUser]};
        }

        tasks = [
            assertSetupCompleted(false),
            doSetup,
            sendNotification,
            formatResponse
        ];

        return pipeline(tasks, setupDetails);
    },

    /**
     * Updates the blog setup
     * @param  {Object} setupDetails request payload with setup details
     * @param  {Object} options
     * @return {Promise<Object>} a User API response payload
     */
    updateSetup: function updateSetup(setupDetails, options) {
        var tasks,
            localOptions = _.cloneDeep(options || {});

        function processArgs(setupDetails, options) {
            if (!options.context || !options.context.user) {
                throw new errors.NoPermissionError(i18n.t('errors.api.authentication.notTheBlogOwner'));
            }

            return _.assign({setupDetails: setupDetails}, options);
        }

        function checkPermission(options) {
            return models.User.findOne({role: 'Owner', status: 'all'})
                .then(function (owner) {
                    if (owner.id !== options.context.user) {
                        throw new errors.NoPermissionError(i18n.t('errors.api.authentication.notTheBlogOwner'));
                    }

                    return options.setupDetails;
                });
        }

        function formatResponse(user) {
            return {users: [user]};
        }

        tasks = [
            processArgs,
            assertSetupCompleted(true),
            checkPermission,
            setupTasks,
            formatResponse
        ];

        return pipeline(tasks, setupDetails, localOptions);
    },

    /**
     * Revokes a bearer token.
     * @param {Object} tokenDetails
     * @param {Object} options
     * @return {Promise<Object>} an object containing the revoked token.
     */
    revoke: function revokeToken(tokenDetails, options) {
        var tasks,
            localOptions = _.cloneDeep(options || {});

        function processArgs(tokenDetails, options) {
            return _.assign({}, tokenDetails, options);
        }

        function revokeToken(options) {
            var providers = [
                    models.Refreshtoken,
                    models.Accesstoken
                ],
                response = {token: options.token};

            function destroyToken(provider, options, providers) {
                return provider.destroyByToken(options)
                    .return(response)
                    .catch(provider.NotFoundError, function () {
                        if (!providers.length) {
                            return {
                                token: tokenDetails.token,
                                error: i18n.t('errors.api.authentication.invalidTokenProvided')
                            };
                        }

                        return destroyToken(providers.pop(), options, providers);
                    })
                    .catch(function () {
                        throw new errors.TokenRevocationError(
                            i18n.t('errors.api.authentication.tokenRevocationFailed')
                        );
                    });
            }

            return destroyToken(providers.pop(), options, providers);
        }

        tasks = [
            processArgs,
            revokeToken
        ];

        return pipeline(tasks, tokenDetails, localOptions);
    }
};

module.exports = authentication;
