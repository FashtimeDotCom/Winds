import md5 from 'md5';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import stream from 'getstream';
import uuidv4 from 'uuid/v4';
import validator from 'validator';

import User from '../models/user';
import Podcast from '../models/podcast';
import RSS from '../models/rss';

import logger from '../utils/logger';
import events from '../utils/events';
import config from '../config';

import followRssFeed from '../shared/followRssFeed';
import followPodcast from '../shared/followPodcast';

const client = stream.connect(config.stream.apiKey, config.stream.apiSecret);

exports.signup = (req, res) => {
	const data = req.body || {};

	if (!data.email || !data.name || !data.password) {
		return res.sendStatus(422);
	}

	if (data.email && !validator.isEmail(data.email)) {
		return res.status(422).send('Invalid email address.');
	}

	if (data.username && !validator.isAlphanumeric(data.username)) {
		return res.status(422).send('Usernames must be alphanumeric.');
	}

	User.findOne({ email: data.email.toLowerCase(), username: data.username }).then(
		foundUser => {
			if (foundUser) {
				return res
					.status(409)
					.send('A user already exists with that username or email.');
			} else {
				User.create(data)
					.then(createdUser => {
						return Promise.all([
							client
								.feed('timeline', createdUser._id)
								.follow('user', createdUser._id),
						]).then(() => {
							return createdUser;
						});
					})
					.then(createdUser => {
						if (process.env.NODE_ENV === 'production') {
							let obj = {
								meta: {
									data: {},
								},
							};

							obj.meta.data[`user:${createdUser._id}`] = {
								email: createdUser.email,
							};
							return events(obj).then(() => {
								return createdUser;
							});
						} else {
							return createdUser;
						}
					})
					.then(createdUser => {
						return RSS.find({ featured: true }).then(featuredRssFeeds => {
							return Promise.all(
								featuredRssFeeds.map(featuredRssFeed => {
									return followRssFeed(
										createdUser._id,
										featuredRssFeed._id,
									);
								}),
							).then(() => {
								return createdUser;
							});
						});
					})
					.then(createdUser => {
						return Podcast.find({ featured: true })
							.then(featuredPodcasts => {
								return Promise.all(
									featuredPodcasts.map(featuredPodcast => {
										return followPodcast(
											createdUser._id,
											featuredPodcast._id,
										);
									}),
								);
							})
							.then(() => {
								return createdUser;
							});
					})
					.then(createdUser => {
						// follow all podcasts and rss feeds specified in "interests" payload
						return Promise.all(
							data.interests.map(interest => {
								// all interests
								return Promise.all([
									// rss and podcasts
									RSS.find({ interest }).then(interestRssFeeds => {
										return Promise.all(
											interestRssFeeds.map(interestRssFeed => {
												return followRssFeed(
													createdUser._id,
													interestRssFeed._id,
												);
											}),
										);
									}),
									Podcast.find({ interest }).then(interestPodcasts => {
										return Promise.all(
											interestPodcasts.map(interestPodcast => {
												return followPodcast(
													createdUser._id,
													interestPodcast._id,
												);
											}),
										);
									}),
								]);
							}),
						).then(() => {
							return createdUser;
						});
					})
					.then(createdUser => {
						res.json({
							_id: createdUser._id,
							email: createdUser.email,
							interests: createdUser.interests,
							jwt: jwt.sign(
								{
									email: createdUser.email,
									sub: createdUser._id,
								},
								config.jwt.secret,
							),
							name: createdUser.name,
							username: createdUser.username,
						});
					})
					.catch(err => {
						logger.error(err);
						res.status(500).send(err);
					});
			}
		},
	);
};

exports.login = (req, res) => {
	const data = req.body || {};

	if (data.email && data.password) {
		let email = data.email.toLowerCase();
		let password = data.password;

		User.findOne({ email: email })
			.then(user => {
				if (!user) {
					return res.sendStatus(404);
				}
				bcrypt
					.compare(password, user.password)
					.then(val => {
						if (!val) {
							return res.sendStatus(403);
						}

						res.status(200).send({
							_id: user._id,
							email: user.email,
							interests: user.interests,
							jwt: jwt.sign(
								{
									email: user.email,
									sub: user._id,
								},
								config.jwt.secret,
							),
							name: user.name,
							username: user.username,
						});
					})
					.catch(() => {
						res.sendStatus(401);
					});
			})
			.catch(err => {
				logger.error(err);
				res.status(422).send(err.errors);
			});
	} else {
		res.sendStatus(401);
	}
};

exports.forgotPassword = (req, res) => {
	const data = req.body || {};
	let opts = {
		new: true,
	};

	const passcode = uuidv4();

	User.findOneAndUpdate(
		{ email: data.email.toLowerCase() },
		{ recoveryCode: passcode },
		opts,
	)
		.then(user => {
			if (!user) {
				return res.sendStatus(404);
			}

			res.sendStatus(200);
		})
		.catch(err => {
			logger.error(err);
			res.sendStatus(500);
		});
};

exports.resetPassword = (req, res) => {
	const data = req.body || {};
	let opts = {
		new: true,
	};

	User.findOneAndUpdate(
		{ email: data.email.toLowerCase(), recoveryCode: data.passcode },
		{ password: data.password },
		opts,
	)
		.then(user => {
			if (!user) {
				return res.sendStatus(404);
			}

			res.status(200).send({
				_id: user._id,
				email: user.email,
				interests: user.interests,
				jwt: jwt.sign(
					{
						email: user.email,
						sub: user._id,
					},
					config.jwt.secret,
				),
				name: user.name,
				username: user.username,
			});
		})
		.catch(err => {
			logger.error(err);
			res.sendStatus(422);
		});
};
